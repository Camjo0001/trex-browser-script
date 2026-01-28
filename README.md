# Trex Browser Script

Fast Playwright script for scraping NY Courts foreclosure cases. Downloads Judgment and Notice of Sale PDFs in ~30 seconds.

## Prerequisites

- Node.js 18+
- A running Chromium-based browser with remote debugging enabled on port 18800
- Browser must have valid session cookies for iapps.courts.state.ny.us

## Installation

```bash
npm install
```

## Usage

```bash
node scrape-case.js "INDEX_NUMBER" "COUNTY"

# Example
node scrape-case.js "606529/2023" "Suffolk"
```

## Output

PDFs are saved to `/tmp/trex-pdfs/{index-number}/`:
- `judgment.pdf` - Judgment of Foreclosure and Sale
- `notice.pdf` - Notice of Sale

Returns JSON with:
```json
{
  "success": true,
  "indexNumber": "606529/2023",
  "county": "Suffolk",
  "caseDir": "/tmp/trex-pdfs/606529-2023",
  "pdfs": {
    "judgment": "/tmp/trex-pdfs/606529-2023/judgment.pdf",
    "notice": "/tmp/trex-pdfs/606529-2023/notice.pdf"
  },
  "caseInfo": {
    "plaintiff": "...",
    "defendant": "..."
  },
  "documents": [...]
}
```

## hCaptcha

If hCaptcha is detected, the script returns:
```json
{
  "success": false,
  "hcaptchaDetected": true,
  "hcaptchaSitekey": "...",
  "error": "hCaptcha detected"
}
```

Solve the captcha externally and retry.

## How It Works

1. Connects to existing browser via Chrome DevTools Protocol (CDP)
2. Navigates to NY Courts WebCivil search
3. Searches for the case by index number and county
4. Extracts case details and navigates to eFiled documents
5. Downloads Judgment and Notice of Sale PDFs using fetch with credentials
6. Closes the browser tab automatically

## Browser Setup

The script expects a Chromium browser running with:
```bash
--remote-debugging-port=18800
```

For Brave browser:
```bash
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --remote-debugging-port=18800
```

## Supported Counties

- Suffolk
- Nassau
- Kings
- Queens
- Bronx
- New York
- Richmond
- Westchester

## License

MIT
