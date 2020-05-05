import * as puppeteer from 'puppeteer';
import { Page } from 'puppeteer';
import * as url from 'url';

import { Config } from './config';

export type SerializedResponse = {
  status: number;
  customHeaders: Map<string, string>;
  content: string;
};

export type PreviewResponse = {
  status: number;
  title: string | null;
  description: string | null;
  domain: string;
  img: string | null;
};

type ViewportDimensions = {
  width: number; height: number;
};

const MOBILE_USERAGENT =
    'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private browser: puppeteer.Browser;
  private config: Config;

  constructor(browser: puppeteer.Browser, config: Config) {
    this.browser = browser;
    this.config = config;
  }

  async serialize(requestUrl: string, isMobile: boolean, preview: boolean = false):
      Promise<SerializedResponse | PreviewResponse> {
    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage() {
      // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
      const elements = document.querySelectorAll('script:not([type]), script[type*="javascript"], link[rel=import]');
      for (const e of Array.from(elements)) {
        e.remove();
      }
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string) {
      const base = document.createElement('base');
      base.setAttribute('href', origin);

      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          bases[0].setAttribute('href', origin + existingBase);
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({width: this.config.width, height: this.config.height, isMobile});

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    page.evaluateOnNewDocument('customElements.forcePolyfill = true');
    page.evaluateOnNewDocument('ShadyDOM = {force: true}');
    page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

    let response: puppeteer.Response | null = null;
    // Capture main frame response. This is used in the case that rendering
    // times out, which results in puppeteer throwing an error. This allows us
    // to return a partial response for what was able to be rendered in that
    // time frame.
    page.addListener('response', (r: puppeteer.Response) => {
      if (!response) {
        response = r;
      }
    });

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response = await page.goto(
          requestUrl, {timeout: this.config.timeout, waitUntil: 'networkidle0'});
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      console.error('response does not exist');
      // This should only occur when the page is about:blank. See
      // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
      await page.close();
      return {status: 400, customHeaders: new Map(), content: ''};
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      return {status: 403, customHeaders: new Map(), content: ''};
    }

    // Set status to the initial server's response code. Check for a <meta
    // name="render:status_code" content="4xx" /> tag which overrides the status
    // code.
    let statusCode = response.status();
    const newStatusCode =
        await page
            .$eval(
                'meta[name="render:status_code"]',
                (element) => parseInt(element.getAttribute('content') || ''))
            .catch(() => undefined);
    // On a repeat visit to the same origin, browser cache is enabled, so we may
    // encounter a 304 Not Modified. Instead we'll treat this as a 200 OK.
    if (statusCode === 304) {
      statusCode = 200;
    }
    // Original status codes which aren't 200 always return with that status
    // code, regardless of meta tags.
    if (statusCode === 200 && newStatusCode) {
      statusCode = newStatusCode;
    }

    // Check for <meta name="render:header" content="key:value" /> tag to allow a custom header in the response
    // to the crawlers.
    const customHeaders = await page
      .$eval(
        'meta[name="render:header"]',
        (element) => {
          const result = new Map<string, string>();
          const header = element.getAttribute('content');
          if (header) {
            const i = header.indexOf(':');
            if (i !== -1) {
              result.set(
                header.substr(0, i).trim(),
                header.substring(i + 1).trim());
            }
          }
          return JSON.stringify([...result]);
        })
        .catch(() => undefined);

    if (preview) {
      const result = {
        title: await this.getTitle(page),
        description: await this.getDescription(page),
        domain: await this.getDomainName(page, requestUrl),
        img: await this.getImg(page, requestUrl),
        status: statusCode
      };
      await page.close();
      return result;
    } else {
      // Remove script & import tags.
      await page.evaluate(stripPage);
      // Inject <base> tag with the origin of the request (ie. no path).
      const parsedUrl = url.parse(requestUrl);
      await page.evaluate(
        injectBaseHref, `${parsedUrl.protocol}//${parsedUrl.host}`);

      // Serialize page.
      const result = await page.content() as string;

      await page.close();
      return { status: statusCode, customHeaders: customHeaders ? new Map(JSON.parse(customHeaders)) : new Map(), content: result };
    }
  }

  async getImg(page: Page, uri: string) {
    return page.evaluate(async () => {
      const ogImg = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (
        ogImg != null &&
        ogImg.content.length > 0
      ) {
        return ogImg.content;
      }
      const imgRelLink = document.querySelector('link[rel="image_src"]') as HTMLLinkElement;
      if (
        imgRelLink != null &&
        imgRelLink.href.length > 0
      ) {
        return imgRelLink.href;
      }
      const twitterImg = document.querySelector('meta[name="twitter:image"]') as HTMLMetaElement;
      if (
        twitterImg != null &&
        twitterImg.content.length > 0
      ) {
        return twitterImg.content;
      }

      let imgs = Array.from(document.getElementsByTagName('img'));
      if (imgs.length > 0) {
        imgs = imgs.filter((img) => {
          let addImg = true;
          if (img.naturalWidth > img.naturalHeight) {
            if (img.naturalWidth / img.naturalHeight > 3) {
              addImg = false;
            }
          } else {
            if (img.naturalHeight / img.naturalWidth > 3) {
              addImg = false;
            }
          }
          if (img.naturalHeight <= 50 || img.naturalWidth <= 50) {
            addImg = false;
          }
          return addImg;
        });
        imgs.forEach((img) =>
          img.src.indexOf('//') === -1
            ? (img.src = `${new URL(uri).origin}/${img.src}`)
            : img.src
        );
        return imgs[0].src;
      }
      return null;
    });
  }

  async getTitle(page: Page) {
    return page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]') as HTMLMetaElement;
      if (ogTitle != null && ogTitle.content.length > 0) {
        return ogTitle.content;
      }
      const twitterTitle = document.querySelector('meta[name="twitter:title"]') as HTMLMetaElement;
      if (twitterTitle != null && twitterTitle.content.length > 0) {
        return twitterTitle.content;
      }
      const docTitle = document.title;
      if (docTitle != null && docTitle.length > 0) {
        return docTitle;
      }
      const h1 = (document.querySelector('h1') as HTMLHeadElement).innerHTML;
      if (h1 != null && h1.length > 0) {
        return h1;
      }
      const h2 = (document.querySelector('h1') as HTMLHeadElement).innerHTML;
      if (h2 != null && h2.length > 0) {
        return h2;
      }
      return null;
    });
  }

  async getDescription(page: Page) {
    return page.evaluate(() => {
      const ogDescription = document.querySelector(
        'meta[property="og:description"]'
      ) as HTMLMetaElement;
      if (ogDescription != null && ogDescription.content.length > 0) {
        return ogDescription.content;
      }
      const twitterDescription = document.querySelector(
        'meta[name="twitter:description"]'
      ) as HTMLMetaElement;
      if (twitterDescription != null && twitterDescription.content.length > 0) {
        return twitterDescription.content;
      }
      const metaDescription = document.querySelector('meta[name="description"]') as HTMLMetaElement;
      if (metaDescription != null && metaDescription.content.length > 0) {
        return metaDescription.content;
      }
      const paragraphs = document.querySelectorAll('p');
      let fstVisibleParagraph = null;
      for (let i = 0; i < paragraphs.length; i++) {
        if (
          // if object is visible in dom
          paragraphs[i].offsetParent !== null &&
          paragraphs[i].childElementCount !== 0
        ) {
          fstVisibleParagraph = paragraphs[i].textContent;
          break;
        }
      }
      return fstVisibleParagraph;
    });
  }

  async getDomainName(page: Page, uri: string) {
    const domainName = await page.evaluate(() => {
      const canonicalLink = document.querySelector('link[rel=canonical]') as HTMLLinkElement;
      if (canonicalLink != null && canonicalLink.href.length > 0) {
        return canonicalLink.href;
      }
      const ogUrlMeta = document.querySelector('meta[property="og:url"]') as HTMLMetaElement;
      if (ogUrlMeta != null && ogUrlMeta.content.length > 0) {
        return ogUrlMeta.content;
      }
      return null;
    });
    return domainName != null
      ? new URL(domainName).hostname.replace('www.', '')
      : new URL(uri).hostname.replace('www.', '');
  }

  async screenshot(
      url: string,
      isMobile: boolean,
      dimensions: ViewportDimensions,
      options?: object): Promise<Buffer> {
    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport(
        {width: dimensions.width, height: dimensions.height, isMobile});

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    let response: puppeteer.Response|null = null;

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response =
          await page.goto(url, {timeout: this.config.timeout, waitUntil: 'networkidle0'});
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      await page.close();
      throw new ScreenshotError('NoResponse');
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response!.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      throw new ScreenshotError('Forbidden');
    }

    // Must be jpeg & binary format.
    const screenshotOptions =
        Object.assign({}, options, {type: 'jpeg', encoding: 'binary'});
    // Screenshot returns a buffer based on specified encoding above.
    // https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagescreenshotoptions
    const buffer = await page.screenshot(screenshotOptions) as Buffer;
    await page.close();
    return buffer;
  }
}

type ErrorType = 'Forbidden'|'NoResponse';

export class ScreenshotError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    super(type);

    this.name = this.constructor.name;

    this.type = type;
  }
}
