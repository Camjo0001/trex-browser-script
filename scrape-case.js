#!/usr/bin/env node
/**
 * Playwright Court Scraper - Downloads PDFs then closes tab
 * 
 * Usage:
 *   node scrape-case.js "606529/2023" "Suffolk"
 * 
 * Output:
 *   JSON with PDF paths ready for vision processing
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CDP_URL = 'http://127.0.0.1:18800';
const SEARCH_URL = 'https://iapps.courts.state.ny.us/webcivil/FCASSearch';
const DOWNLOAD_DIR = '/tmp/trex-pdfs';

async function scrapeCase(indexNumber, county) {
  const caseDir = path.join(DOWNLOAD_DIR, indexNumber.replace('/', '-'));
  fs.mkdirSync(caseDir, { recursive: true });

  const result = {
    success: false,
    indexNumber,
    county,
    caseDir,
    pdfs: {},
    images: {},
    error: null,
    hcaptchaDetected: false,
    caseInfo: null,
    documents: []
  };

  let browser, page;

  try {
    console.log(`[1/7] Connecting to browser...`);
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
    page = await browser.newPage();
    
    console.log(`[2/7] Opening search page...`);
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#txtIndex', { timeout: 30000 });

    console.log(`[3/7] Searching for ${indexNumber}...`);
    await page.type('#txtIndex', indexNumber, { delay: 50 });
    
    // Select county
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
      await page.close();
      return result;
    }

    // Find case
    const caseLink = await page.$('a[onclick*="openCaseDetailsWindow"]');
    if (!caseLink) {
      result.error = 'No case found';
      await page.close();
      return result;
    }

    console.log(`[4/7] Navigating to case details...`);
    const onclick = await page.$eval('a[onclick*="openCaseDetailsWindow"]', el => el.getAttribute('onclick'));
    const params = onclick.match(/openCaseDetailsWindow\(([^)]+)\)/)[1].split(',').map(p => p.trim().replace(/['"]/g, ''));
    
    const caseUrl = `https://iapps.courts.state.ny.us/webcivil/FCASCaseInfo?parm=${params[1]}&index=${params[3]}&county=${params[2]}&motion=${params[4]}&docs=${params[5]}&adate=${params[6]}&civilCaseId=${params[7]}`;
    
    await page.goto(caseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Get basic case info
    const caseText = await page.evaluate(() => document.body.innerText);
    result.caseInfo = {
      plaintiff: (caseText.match(/Plaintiff[s]?[:\s]+([^\n]+)/i) || [])[1]?.trim(),
      defendant: (caseText.match(/Defendant[s]?[:\s]+([^\n]+)/i) || [])[1]?.trim()
    };

    console.log(`[5/7] Navigating to eFiled documents...`);
    const efiledOnclick = await page.$eval('input[onclick*="openDocumentWindow"]', el => el.getAttribute('onclick')).catch(() => null);
    if (!efiledOnclick) {
      result.error = 'No eFiled docs button';
      await page.close();
      return result;
    }

    const efiledParams = efiledOnclick.match(/openDocumentWindow\(([^)]+)\)/)[1].split(',').map(p => p.trim().replace(/['"]/g, ''));
    const efiledUrl = `https://iapps.courts.state.ny.us/webcivil/FCASeFiledDocsDetail?county_code=${efiledParams[1]}&txtIndexNo=${efiledParams[2]}&showMenu=no&isPreRji=${efiledParams[3]}&civilCase=${efiledParams[4]}`;
    
    await page.goto(efiledUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log(`[6/7] Finding documents...`);
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
      await page.close();
      return result;
    }
    result.documents = docs;

    console.log(`[7/7] Downloading ${docs.length} PDF(s)...`);
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
        console.log(`   ✓ ${filename}`);
      } catch (e) {
        console.log(`   ✗ ${filename}: ${e.message}`);
      }
    }

    // Close tab immediately after downloads
    console.log(`[✓] Closing browser tab...`);
    await page.close();
    page = null;

    result.success = Object.keys(result.pdfs).length > 0;

  } catch (err) {
    result.error = err.message;
    console.error(`[ERROR] ${err.message}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return result;
}

if (require.main === module) {
  const [indexNumber, county] = process.argv.slice(2);
  if (!indexNumber || !county) {
    console.log('Usage: node scrape-case.js "INDEX" "COUNTY"');
    process.exit(1);
  }
  scrapeCase(indexNumber, county).then(r => {
    console.log('\n' + JSON.stringify(r, null, 2));
    process.exit(r.success ? 0 : 1);
  });
}

module.exports = { scrapeCase };
