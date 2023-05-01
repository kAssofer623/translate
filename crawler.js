const puppeteer = require('puppeteer');
const { URL } = require('url');
const { runNuclei } = require('./nucleiIntegration');
const fs = require('fs');
const moment = require('moment');
const crawledUrls = new Set();
const skippedUrls = new Set();
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const Shelter = new Set();
const path = require('path');
const axios = require('axios');
const retire = require('retire');
const { spawn } = require('child_process');
const rimraf = require('rimraf');
const _ = require('lodash');
const { Client } = require('@elastic/elasticsearch');
const EventEmitter = require('events');
EventEmitter.defaultMaxListeners = 20;

//ElasticSearch Credentials
const esClient = new Client({ 
  node: 'https://localhost:9200', 
  auth: {
    username: 'elastic',
    password: '4GzBGuWbSnsfps8eopp4'
  },
  tls: {
    ca: fs.readFileSync('./http_ca.crt'),
    rejectUnauthorized: false
  } 
});

//ElasticSearch Logging 
async function sendLogToElasticsearch(level, message) {
  try {
    await esClient.index({
      index: `app-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`,
      body: {
        level: level,
        message: message,
        '@timestamp': new Date().toISOString(),
        service: 'app',
      },
    });

    //Print that the log was sent to elastic in the console
    //console.log(`[${new Date().toISOString()}] Log sent to Elasticsearch: ${level.toUpperCase()} - ${message}`);
  } catch (error) {
    console.error('Error sending log to Elasticsearch:', error);
  }
}

async function deleteLogsInAppLogsDataView() {
  const response = await esClient.deleteByQuery({
    index: 'app-*',
    body: {
      query: {
        match_all: {}
      }
    }
  });
}
async function main() {
  console.log('Starting cleanup...');
  await deleteLogsInAppLogsDataView();
  console.log('Kibana Cleanup completed successfully');
}

main();

let stopCrawling = false;
const userAgentList = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.82 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:86.0) Gecko/20100101 Firefox/86.0',
];

const options = {
  delay: parseInt(process.argv.find((arg, i) => arg === '--delay' && process.argv[i + 1]) || '0', 10) * 1000,
  useRandomAgent: process.argv.includes('--random-agent'),
  isHeadless: !process.argv.includes('--no-headless'),
  waitEntrypoint: parseInt(process.argv.find((arg, i) => arg === '--wait-entrypoint' && process.argv[i + 1]) || '0', 10),
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: node crawl.js [options] <url>

Options:
  --auth <file>            Replay authentication using Chrome Recorder JSON file       
  --delay <seconds>        Delay between requests (default: 0)
  --random-agent           Use a random user agent
  --no-headless            Run in non-headless mode
  --wait-entrypoint <ms>   Set the wait time for the entrypoint page (default: 0)

Example:
  node crawler.js https://brokencrystals.com/ --auth authentication.json
  `);
  process.exit(0);
}

let totalErrors = 0;

async function clickWithTimeout(page, selector, timeout) {
  try {
    await Promise.race([
      page.waitForSelector(selector, { timeout }),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);
    await page.click(selector);
    return true;
  } catch (error) {
    return false;
  }
}

async function replayAuthFlow(page, authFlow) {
  const { steps } = authFlow;
  let responseHeaders = {};

  // Find the index of the step that sets the viewport
  const setViewportStepIndex = steps.findIndex(step => step.type === 'setViewport');

  // If the step exists, remove it from the auth flow steps array
  if (setViewportStepIndex !== -1) {
    console.log('Viewport step found in auth flow. Removing...');
    steps.splice(setViewportStepIndex, 1);
  }

  page.on('response', response => {
    const step = authFlow.steps.find(step => step.url === response.url());
    // console.log(`Response headers for step ${authFlow.steps.indexOf(step)}: ${JSON.stringify(response.headers())}`);
  });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepType = step.type;
    const stepValue = step.value || step;
    // console.log(`Step ${i + 1} - ${stepType}: ${JSON.stringify(stepValue)}`);
    // console.log(`Response headers for step ${i}: ${JSON.stringify(responseHeaders)}`);

    await performStep(page, step);
    // Save screenshot after performing the step
    const screenshotDir = path.join(__dirname, '/auth/screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    const screenshotPath = path.join(screenshotDir, `step-${i + 1}-${stepType}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log('\x1b[32m%s\x1b[0m', `Screenshot saved for step ${i + 1} at ${screenshotPath}`);
  }

  console.log('\x1b[32m%s\x1b[0m','Authentication replayed successfully!');
  console.log('\x1b[36m%s\x1b[0m', 'Starting crawling the application')
  console.log('\x1b[32m%s\x1b[0m', '---------------------------------------')
  // console.log(`Response headers from the last step of the auth flow: ${JSON.stringify(responseHeaders)}`);
  return responseHeaders;
}

let stepCounter = 0;

async function performStep(page, step) {
  stepCounter++;
  try {
    switch (step.type) {
      case 'navigate':
        console.log(`Navigating to ${step.url}`);
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCache');
        console.log('Cache cleared successfully');
        await page.goto(step.url, { waitUntil: 'networkidle0' });
        console.log(`Navigation to ${step.url} completed`);
        break;
      case 'click':
        console.log(`Clicking on selector ${step.selectors}`);
        let clicked = false;
        let waitForNavigation = false;
        for (const selectorArr of step.selectors) {
          const selector = selectorArr[0];
          clicked = await clickWithTimeout(page, selector, 15000);
          if (clicked) {
            console.log('\x1b[32m%s\x1b[0m', `Clicked on selector ${selector}`);
            waitForNavigation = 'assertedEvents' in step && step.assertedEvents.some(event => event.type === 'navigation');
            break;
          }
        }
        if (!clicked) {
          console.error(`No selectors found for clicking in step ${stepCounter}`);
        } else if (waitForNavigation) {
          const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0' });
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), 15000));
          await Promise.race([navigationPromise, timeoutPromise]);
        }
        break;
      case 'change':
        console.log(`Stage ${++stepCounter} - change: ${JSON.stringify(step)}`);
        console.log(`Changing value of selector ${step.selectors} to ${step.value}`);
        await page.waitForSelector(step.selectors[0].toString().trim(), { timeout: 5000 });
        await page.type(step.selectors[0].toString().trim(), step.value);
        console.log('\x1b[32m%s\x1b[0m',`Changed value of selector ${step.selectors} to ${step.value}`);
        break;
      case 'keyDown':
        console.log(`Stage ${++stepCounter} - keyDown: ${JSON.stringify(step)}`);
        console.log(`Pressing key ${step.key}`);
        await page.keyboard.down(step.key);
        console.log('\x1b[32m%s\x1b[0m',`Key ${step.key} pressed`);
        break;
      case 'keyUp':
        console.log(`Stage ${++stepCounter} - keyUp: ${JSON.stringify(step)}`);
        console.log(`Releasing key ${step.key}`);
        await page.keyboard.up(step.key);
        console.log('\x1b[32m%s\x1b[0m',`Key ${step.key} released`);
        break;
      default:
        console.error(`Unknown step type: ${step.type}`);
        break;
    }
    await page.waitForTimeout(1000);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', `Error during step ${stepCounter}: ${error.message}`);
    // continue execution even if error occurs
  }
}

  
  //HAR log file name (at the bottom we have the HAR creation)
  // const createLogFilename = (domain) => {
  //   const currentDate = moment().format('MM-DD-YY');
  //   return `${domain}-${currentDate}.log`;
  // };


async function extractFormData(page) {
  const forms = await page.$$('form');
  const postData = [];

  page.on('requestfinished', (request) => {
    if (request.method() === 'POST' && request.postData()) {
      postData.push(request.postData());
    }
  });

  await Promise.all(
    forms.map(async (form) => {
      const formMethod = await form.evaluate((el) => el.method);
      const formAction = await form.evaluate((el) => el.action);
      const inputs = await form.$$eval('input, textarea, select', (elements) =>
        elements.map((el) => ({
          name: el.name,
          type: el.type,
          value: el.value,
        }))
      );

      if (formMethod.toLowerCase() === 'post') {
        await form.evaluate((el) => el.submit());
      }
    })
  );

  return postData;
}


async function downloadAndScanJsFiles(urls) {
  const jsFiles = urls.filter(url => url.endsWith('.js'));

  if (jsFiles.length === 0) {
    console.log('No JS files found to download and scan.');
    return;
  }

  const jsFilesDir = path.join(__dirname, 'js-files');

  await new Promise((resolve, reject) => {
    fs.mkdir(jsFilesDir, { recursive: true }, (err) => {
      if (err && err.code !== 'EEXIST') {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  await Promise.all(jsFiles.map(async (jsFileUrl) => {
    try {
      const response = await axios.get(jsFileUrl);
      const filename = path.basename(jsFileUrl);
      const filepath = path.join(jsFilesDir, filename);

      await fs.promises.writeFile(filepath, response.data);
      console.log(`Downloaded ${jsFileUrl} to ${filepath}`);

      await runRetireJsScan(filepath, jsFilesDir);
    } catch (error) {
      console.error(`Error while downloading and scanning ${jsFileUrl}: ${error.message}`);
    }
  }));

  // Use rimraf to delete the js-files directory
  rimraf(jsFilesDir, (error) => {
    if (error) {
      console.error('Error deleting directory:', error);
    } else {
      console.log('Directory deleted successfully.');
    }
  });
}

function runRetireJsScan(filepath, jsFilesDir) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(filepath);
    const retireProcess = spawn('retire', ['--jspath', '.', '--outputformat', 'jsonsimple', '-c', filename], { cwd: jsFilesDir });

    retireProcess.stdout.on('data', async data => {
      const scanOutput = data.toString().trim();
      const vulns = JSON.parse(scanOutput);
      for (const vuln of vulns) {
        const { file, results } = vuln;
        for (const result of results) {
          const { component, version, vulnerabilities } = result;
          for (const vuln of vulnerabilities) {
            const { severity } = vuln;
            const { summary } = vuln.identifiers;
            const vulnDetails = `RetireJS - Found vulnerability in ${file}: ${component} ${version} - ${severity}: ${summary}`;
            console.log(vulnDetails);

            // Send vulnerability details to Kibana
            await sendLogToElasticsearch('warning', vulnDetails);
          }
        }
      }
    });

    retireProcess.stderr.on('data', data => console.error(data.toString()));
    retireProcess.on('exit', code => {
      if (code !== 0) {
        console.error(`Retire.js exited with code ${code}.`);
        reject(new Error(`Retire.js exited with code ${code}.`));
      } else {
        resolve();
      }
    });
  });
}


//generate ID for each request/response
function generateRequestId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz123456789';
  let id = '';

  for (let i = 0; i < 10; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return id;
}

//exclude entrypoint
function shouldSkipUrl(url) {
  const excludePattern = new RegExp(
    "(?<excluded_file_ext>(\/\/[^?#]+\\.)" +
      "((?<image>jpg|jpeg|png|gif|svg|eps|webp|tif|tiff|bmp|psd|ai|raw|cr|pcx|tga|ico)|" +
      "(?<video>mp4|avi|3gp|flv|h264|m4v|mkv|mov|mpg|mpeg|vob|wmv)|" +
      "(?<audio>wav|mp3|ogg|wma|mid|midi|aif)|" +
      "(?<document>doc|docx|odt|pdf|rtf|ods|xls|xlsx|odp|ppt|pptx)|" +
      "(?<font>ttf|otf|fnt|fon|woff|woff2))(?:$|#|\\?))"
  );
  return excludePattern.test(url);
}


function getParameterDetails(request) {
  const url = new URL(request.url());
  const locations = [];
  //query parameter
  if (url.search) {
    locations.push({ location: 'query', params: Array.from(url.searchParams.keys()) });
  }
  //path parameter
  if (url.pathname.includes('/:')) {
    const params = url.pathname.split('/').filter(segment => segment.startsWith(':')).map(segment => {
      const paramName = segment.slice(1);
      let paramType = 'string';
      let paramValue = null;
      const paramRegex = new RegExp(`:${paramName}([a-zA-Z]+)?`);
      const match = url.pathname.match(paramRegex);
      if (match) {
        const paramSegment = match[0];
        paramValue = paramSegment.slice(paramName.length + 1);
        if (paramValue === 'true' || paramValue === 'false') {
          paramType = 'boolean';
          paramValue = paramValue === 'true';
        } else if (!isNaN(Number(paramValue))) {
          paramType = 'number';
          paramValue = Number(paramValue);
        }
      }
      return { name: paramName, type: paramType, value: paramValue };
    });
    if (params.length > 0) {
      locations.push({ location: 'path', params });
    }
  }
  //fragment parameter
  if (url.hash) {
    locations.push({ location: 'fragment', params: [url.hash] });
  }
  //body parameter
  if (request.postData()) {
    locations.push({ location: 'body', params: Object.keys(JSON.parse(request.postData())) });
  }

  return {
    location: locations.map(loc => loc.location).join(', '),
    parameterDetails: locations.flatMap(loc => loc.params)
  };
}


function hasBaseUrl(set, baseUrl) {
  for (const item of set) {
    if (item.startsWith(baseUrl)) {
      return true;
    }
  }
  return false;
}

  //main engine
  const crawl = async (entrypoint, auth) => {
    const baseUrl = new URL(entrypoint);
    const domain = baseUrl.hostname;
    const visited = new Set();
    const queue = [entrypoint];
    console.log(`Starting a scan against: ${entrypoint}`)
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    let lastResponseHeaders = {};
    const authFile = auth;

    if (authFile) {
      console.log(`Using authentication file: ${authFile}`);
      const authData = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      const { isSuccess, headers } = await replayAuthFlow(page, authData); // Destructure the returned object
      // console.log('Response headers from the last step of the auth flow:', headers); // Log the headers
    } else {
      console.log('No authentication file provided.');
    }

    if (options.useRandomAgent) {
      const userAgent = userAgentList[Math.floor(Math.random() * userAgentList.length)];
      await page.setUserAgent(userAgent);
    }

    const entries = [];
    await page.tracing.start({ categories: ['devtools.timeline'] });
    
    // Register a listener for each request made by the browser
    page.on('request', async (request) => {
      // Generate a requestId for the request
      const requestId = generateRequestId();
      // Store the requestId in the request object
      request.requestId = requestId;
      // Log the request details to Elasticsearch
      await sendLogToElasticsearch('INFO', `request (${requestId}) - ${request.method().toUpperCase()} ${request.url()} ${JSON.stringify(request.headers())}`);

      // Check if the URL of the request has already been crawled and should not be skipped
      if (crawledUrls.has(request.url()) && !shouldSkipUrl(request.url())) {
        const { baseUrl, location, parameterDetails } = getParameterDetails(request);
        if (parameterDetails.length > 0 && !hasBaseUrl(Shelter, baseUrl)) {
          Shelter.add(request.url());
          await sendLogToElasticsearch(
            'INFO',
            `Added entrypoint to Shelter: ${request.method()} ${request.url()} with ${parameterDetails.length} parameters in ${location}: ${parameterDetails.join(', ')}`
          );
        } else if (parameterDetails.length === 0 && !Shelter.has(request.url())) {
          Shelter.add(request.url());
          await sendLogToElasticsearch(
            'INFO',
            `Added entrypoint to Shelter: ${request.method()} ${request.url()}`
          );
        }
      }

      // Check if the request is a redirect
      if (request.isNavigationRequest() && request.redirectChain().length > 0) {
        const redirectChain = request.redirectChain();
        const lastRedirectRequest = redirectChain[redirectChain.length - 1];
        const redirectUrl = lastRedirectRequest.url();
        const parentUrl = new URL(request.url()).origin + new URL(request.url()).pathname.split('/').slice(0, -1).join('/');
        const fullRedirectUrl = new URL(redirectUrl, parentUrl).toString();
        if (fullRedirectUrl.startsWith(baseUrl.origin)) {
          if (!visited.has(fullRedirectUrl) && !queue.includes(fullRedirectUrl) && !shouldSkipUrl(fullRedirectUrl)) {
            queue.push(fullRedirectUrl);
            if (!crawledUrls.has(fullRedirectUrl)) {
              crawledUrls.add(fullRedirectUrl);
              Shelter.add(fullRedirectUrl);
              console.log('\x1b[32m%s\x1b[0m', `New entrypoint found through redirection: ${fullRedirectUrl}`);
            }
          }
        }
      }
    });


    page.on('response', async (response) => {
      const request = response.request();
      const requestId = request.requestId; // Retrieve the requestId from the request object

      if (response.status() !== 301 && response.status() !== 302 && response.status() !== 303 && response.status() !== 307 && response.status() !== 308) {
        const isPreflightRequest = request.method() === 'OPTIONS' &&
          request.headers()['access-control-request-method'] &&
          request.headers()['access-control-request-headers'];
        if (!isPreflightRequest) {
          try {
            const buffer = await response.buffer();
            const responseDetails = {
              url: response.url(),
              status: response.status(),
              headers: response.headers(),
              body: buffer.toString(),
            };
            // console.log('Response:', responseDetails);
            entries.push({ request, responseDetails });

            // Log the response details with the requestId
            await sendLogToElasticsearch('INFO', `response (${requestId}) - ${JSON.stringify(responseDetails)}`);

            if (response.status() >= 300 && response.status() < 400) {
              const redirectUrl = response.headers().location;
              const parentUrl = new URL(request.url()).origin + new URL(request.url()).pathname.split('/').slice(0, -1).join('/');
              const fullRedirectUrl = new URL(redirectUrl, parentUrl).toString();
              if (fullRedirectUrl.startsWith(baseUrl.origin)) {
                if (!visited.has(fullRedirectUrl) && !queue.includes(fullRedirectUrl) && !shouldSkipUrl(fullRedirectUrl)) {
                  if (!fullRedirectUrl.endsWith('/undefined')) {  // added condition to check if URL ends with '/undefined'
                    queue.push(fullRedirectUrl);
                    if (!crawledUrls.has(fullRedirectUrl)) {
                      crawledUrls.add(fullRedirectUrl);
                      Shelter.add(fullRedirectUrl);
                      console.log('\x1b[32m%s\x1b[0m', `New entrypoint found through redirection: ${fullRedirectUrl}`);
                    }
                  }
                }
              }
            }


          } catch (error) {
            console.warn(`Error while getting response body for ${response.url()}: ${error.message}`);
          }
        }
      }
    });

    while (queue.length > 0 && !stopCrawling) {
      const url = queue.shift();
      // Check if the URL is not valid, already visited, or should be skipped based on the excludePattern
      if (!url || url === 'about:blank' || visited.has(url) || shouldSkipUrl(url)) {
        skippedUrls.add(url);
        continue;
      }

      visited.add(url);
      const parentUrl = new URL(url).origin + new URL(url).pathname.split('/').slice(0, -1).join('/');
      if (!visited.has(parentUrl) && !queue.includes(parentUrl) && !shouldSkipUrl(parentUrl)) {
        queue.push(parentUrl);
      }

      try {
        await page.goto(url, { waitUntil: 'networkidle0' });
          const links = await page.$$eval('a, link, area, [onclick*="location.href"], [onclick*="window.location"], [onmousedown*="location.href"], [onmousedown*="window.location"], [data-href], [data-link], [data-url], [data-redirect], [data-ga-track], script[src], img[src], li, button[onclick], button[onmousedown], div', elements => {
          return elements.map(element => {
            if (element.tagName.toLowerCase() === 'a') {
              return element.href;
            } else if (['link', 'area', 'li', 'div'].includes(element.tagName.toLowerCase())) {
              return element.href || element.getAttribute('href');
            } else if (['img', 'script'].includes(element.tagName.toLowerCase())) {
              return element.src || element.getAttribute('src');
            } else if (
              ['[onclick*="location.href"]', '[onclick*="window.location"]', '[onmousedown*="location.href"]', '[onmousedown*="window.location"]', '[data-href]', '[data-link]', '[data-url]', '[data-redirect]', '[data-ga-track]'].some(selector => element.matches(selector))
            ) {
              return element.getAttribute('href');
            } else if (element.tagName.toLowerCase() === 'button') {
              if (element.getAttribute('onclick') || element.getAttribute('onmousedown')) {
                const onClickAttribute = element.getAttribute('onclick') || element.getAttribute('onmousedown');
                const urlMatch = onClickAttribute.match(/(?:window\.location|location\.href)[\s]*=[\s]*['"`]([^'"`]+)['"`]/);
                if (urlMatch && urlMatch[1]) {
                  return urlMatch[1];
                }
              }
              console.log(`Found button with text: ${element.textContent.trim()}`);
            }
            return null;
          });
        });

        // Follow all the links extracted from the page
        links.forEach((link) => {
          let linkUrl;
          try {
            linkUrl = new URL(link, url).toString();
          } catch {
            return;
          }

          if (
            linkUrl.startsWith(baseUrl.origin) &&
            !visited.has(linkUrl) &&
            !queue.includes(linkUrl)
          ) {
            if (shouldSkipUrl(linkUrl) || linkUrl.endsWith('/null')) {
              skippedUrls.add(linkUrl);
            } else {
              queue.push(linkUrl);
              if (!crawledUrls.has(linkUrl)) {
                crawledUrls.add(linkUrl);
                console.log('\x1b[32m%s\x1b[0m',`New page found: ${linkUrl}`);
              }
            }
          }
        });

        await new Promise((resolve) => setTimeout(resolve, options.delay));

      } catch (error) {
        console.warn(`Error while visiting ${url}: ${error.message}`);
        totalErrors++;
      }
    }

    console.log('\x1b[32m%s\x1b[0m', 'Crawler Scan finished');
    await downloadAndScanJsFiles(Array.from(crawledUrls));
    console.log(Shelter)
    await browser.close();
    (async () => {
      
      // Run Nuclei on the discovered URLs
      await runNuclei(Array.from(Shelter), '/home/kass/Desktop/Dev-JSCrawler/src/core-engine/nuclei/nuclei-templates/');
    })();

};

  module.exports = {
  crawl,
};



//KIBANA API
// PUT /my_index/_settings
// {
//   "index.highlight.max_analyzed_offset": 2000000,
//   "index.max_result_window": 50000
// }


//Find all links

// const axios = require('axios');
// const cheerio = require('cheerio');

// const baseUrl = 'https://brokencrystals.com/';

// const fetchPageLinks = async (url) => {
//   try {
//     const { data } = await axios.get(url);
//     const $ = cheerio.load(data);
//     const links = $('a')
//       .map((_, el) => $(el).attr('href'))
//       .get()
//       .filter((link) => link && !link.startsWith('#'));
//     return links.map((link) => new URL(link, baseUrl).toString());
//   } catch (error) {
//     console.error(`Error while fetching ${url}: ${error.message}`);
//     return [];
//   }
// };

// (async () => {
//   const links = await fetchPageLinks(baseUrl);
//   console.log(links);

//   const promises = links.map(fetchPageLinks);
//   const nestedLinks = await Promise.all(promises);
//   const allLinks = nestedLinks.flat();
//   console.log(allLinks);
// })();
