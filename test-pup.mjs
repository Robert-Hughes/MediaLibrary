import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.evaluateOnNewDocument(() => {
    const listeners = new Map();
    window.__TAURI_INVOKE_EVENT = (event, payload) => {
       const handler = listeners.get(event);
       if (handler) handler({ event, id: 1, payload });
    };

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === 'pick_folder') return '/mock/folder';
        if (cmd === 'start_scan') {
          setTimeout(() => {
            const scanId = args.scanId;
            console.log(`Starting scan with id ${scanId}`);
            for (let i = 0; i < 5000; i++) {
               window.__TAURI_INVOKE_EVENT('photo_found', { 
                   scan_id: scanId, 
                   photo: { relative_path: `${i}.jpg`, filename: `${i}.jpg`, date_modified: null, date_created: null } 
               });
            }
            window.__TAURI_INVOKE_EVENT('scan_complete', { scan_id: scanId });
            console.log('Finished sending photo_found events');
          }, 100);
          return 1;
        }
        return null;
      },
      plugins: {
        event: {
          listen: (event, handler) => {
             console.log(`Registered listener for ${event}`);
             listeners.set(event, handler);
             return Promise.resolve(() => listeners.delete(event));
          }
        }
      }
    };
    
    window.__TAURI__ = {
      core: { invoke: window.__TAURI_INTERNALS__.invoke },
      event: { listen: window.__TAURI_INTERNALS__.plugins.event.listen }
    };
  });

  page.on('console', msg => {
    console.log('BROWSER:', msg.text());
  });

  await page.goto('http://localhost:1420', { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    document.querySelector('[data-testid="open-folder-btn"]').click();
  });
  
  await new Promise(r => setTimeout(r, 2000));
  
  const html = await page.evaluate(() => document.body.innerHTML);
  console.log("DOM AFTER 2 SECONDS:");
  console.log(html.substring(0, 1000)); // Print start of DOM
  
  await browser.close();
})();
