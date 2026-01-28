#!/usr/bin/env node
/**
 * Playwright Court Scraper - Downloads PDFs with dashboard updates
 * 
 * Usage:
 *   node scrape-case.js "606529/2023" "Suffolk" [jobId]
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const CDP_URL = 'http://127.0.0.1:18800';
const SEARCH_URL = 'https://iapps.courts.state.ny.us/webcivil/FCASSearch';
const DOWNLOAD_DIR = '/tmp/trex-pdfs';

// Load config for DB connection
let pool = null;
try {
  const config = require('../config.json');
  pool = new Pool({ 
    connectionString: config.database.connectionString, 
    ssl: { rejectUnauthorized: false } 
  });
} catch (e) {
  // No config, skip dashboard updates
}

async function updateDashboard(indexNumber, step, status = 'searching') {
  if (!pool) return;
  const agentId = `scraper-${indexNumber.replace('/', '-')}`;
  try {
    await pool.query(
      `UPDATE agent_status SET current_step = $1, status = $2, last_update = NOW() WHERE agent_id = $3`,
      [step, status, agentId]
    );
  } catch (e) {
    // Ignore dashboard update errors
  }
}

async function scrapeCase(indexNumber, county, jobId = null) {
  const caseDir = path.join(DOWNLOAD_DIR, indexNumber.replace('/', '-'));
  fs.mkdirSync(caseDir, { recursive: true });

  const result = {
    success: false,
    indexNumber,
    county,
    caseDir,
    pdfs: {},
    error: null,
    hcaptchaDetected: false,
    caseInfo: null,
    documents: []
  };

  let browser, page;

  try {
    await updateDashboard(indexNumber, 'Connecting to browser...');
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
    page = await browser.newPage();
    
    await updateDashboard(indexNumber, 'Searching for case...');
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#txtIndex', { timeout: 30000 });

    await page.type('#txtIndex', indexNumber, { delay: 50 });
    
    const countyValue = await page.evaluate((county) => {
      const select = document.querySelector('select[name="cboCourt"]');
      if (!select) return null;
      const match = Array.from(select.options).find(o => 
        o.text.toLowerCase().includes(county.toLowerCase() + ' supreme'));
      return match ? match.value : null;
    }, county);
    
    if (countyValue) await page.select('select[name="cboCourt"]', countyValue);
    
    await Promise.all([
      page.click('#btnFindCase'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
    ]);

    // Check for hCaptcha
    const hcaptcha = await page.$('[data-sitekey], .h-captcha, iframe[src*="hcaptcha"]');
    if (hcaptcha) {
      result.hcaptchaDetected = true;
      result.hcaptchaSitekey = await page.$eval('[data-sitekey]', el => el.getAttribute('data-sitekey')).catch(() => null);
      result.error = 'hCaptcha detected';
      await updateDashboard(indexNumber, 'hCaptcha detected - needs solving', 'failed');
      await page.close();
      return result;
    }

    const caseLink = await page.$('a[onclick*="openCaseDetailsWindow"]');
    if (!caseLink) {
      result.error = 'No case found';
      await updateDashboard(indexNumber, 'No case found', 'failed');
      await page.close();
      return result;
    }

    await updateDashboard(indexNumber, 'Found case, navigating...');
    const onclick = await page.$eval('a[onclick*="openCaseDetailsWindow"]', el => el.getAttribute('onclick'));
    const params = onclick.match(/openCaseDetailsWindow\(([^)]+)\)/)[1].split(',').map(p => p.trim().replace(/['"]/g, ''));
    
    const caseUrl = `https://iapps.courts.state.ny.us/webcivil/FCASCaseInfo?parm=${params[1]}&index=${params[3]}&county=${params[2]}&motion=${params[4]}&docs=${params[5]}&adate=${params[6]}&civilCaseId=${params[7]}`;
    
    await page.goto(caseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const caseText = await page.evaluate(() => document.body.innerText);
    result.caseInfo = {
      plaintiff: (caseText.match(/Plaintiff[s]?[:\s]+([^\n]+)/i) || [])[1]?.trim(),
      defendant: (caseText.match(/Defendant[s]?[:\s]+([^\n]+)/i) || [])[1]?.trim()
    };

    await updateDashboard(indexNumber, 'Getting eFiled documents...');
    const efiledOnclick = await page.$eval('input[onclick*="openDocumentWindow"]', el => el.getAttribute('onclick')).catch(() => null);
    if (!efiledOnclick) {
      result.error = 'No eFiled docs button';
      await updateDashboard(indexNumber, 'No eFiled documents found', 'failed');
      await page.close();
      return result;
    }

    const efiledParams = efiledOnclick.match(/openDocumentWindow\(([^)]+)\)/)[1].split(',').map(p => p.trim().replace(/['"]/g, ''));
    const efiledUrl = `https://iapps.courts.state.ny.us/webcivil/FCASeFiledDocsDetail?county_code=${efiledParams[1]}&txtIndexNo=${efiledParams[2]}&showMenu=no&isPreRji=${efiledParams[3]}&civilCase=${efiledParams[4]}`;
    
    await page.goto(efiledUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const docs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const link = cells[2]?.querySelector('a');
          const docName = link?.textContent?.trim() || '';
          const onclick = link?.getAttribute('onclick') || '';
          if ((docName === 'JUDGMENT OF FORECLOSURE AND SALE' || docName === 'NOTICE OF SALE') && onclick) {
            const urlMatch = onclick.match(/openPDF\(['"]([^'"]+)['"]/);
            if (urlMatch) {
              results.push({
                name: docName,
                type: docName.includes('JUDGMENT') ? 'judgment' : 'notice',
                url: urlMatch[1],
                date: cells[1]?.textContent?.trim()
              });
            }
          }
        }
      });
      return results;
    });

    if (docs.length === 0) {
      result.error = 'No target documents found';
      await updateDashboard(indexNumber, 'No Judgment/Notice found', 'failed');
      await page.close();
      return result;
    }
    result.documents = docs;

    // Download PDFs with progress
    await updateDashboard(indexNumber, `Getting PDFs (0/${docs.length})...`);
    let downloaded = 0;
    
    for (const doc of docs) {
      const filename = doc.type === 'judgment' ? 'judgment.pdf' : 'notice.pdf';
      const filepath = path.join(caseDir, filename);
      
      try {
        const base64 = await page.evaluate(async (url) => {
          const res = await fetch(url, { credentials: 'include' });
          const blob = await res.blob();
          return new Promise(r => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
        }, doc.url);
        
        fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
        result.pdfs[doc.type] = filepath;
        downloaded++;
        await updateDashboard(indexNumber, `Getting PDFs (${downloaded}/${docs.length})...`);
      } catch (e) {
        // Continue on error
      }
    }

    // Close tab
    await page.close();
    page = null;

    result.success = Object.keys(result.pdfs).length > 0;
    
    if (result.success) {
      await updateDashboard(indexNumber, `PDFs downloaded, ready for scan`);
    }

  } catch (err) {
    result.error = err.message;
    await updateDashboard(indexNumber, `Error: ${err.message}`, 'failed');
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return result;
}

async function cleanup() {
  if (pool) await pool.end().catch(() => {});
}

if (require.main === module) {
  const [indexNumber, county, jobId] = process.argv.slice(2);
  if (!indexNumber || !county) {
    console.log('Usage: node scrape-case.js "INDEX" "COUNTY" [jobId]');
    process.exit(1);
  }
  scrapeCase(indexNumber, county, jobId).then(r => {
    console.log(JSON.stringify(r, null, 2));
    return cleanup();
  }).then(() => {
    process.exit(r?.success ? 0 : 1);
  });
}

module.exports = { scrapeCase, updateDashboard, cleanup };
