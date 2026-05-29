export function createExtractor(Firecrawl) {
  let _client = null;

  function getClient(apiKey) {
    const key = apiKey || process.env.FIRECRAWL_API_KEY;
    if (!key) {
      throw new Error("Firecrawl API key is required. Set FIRECRAWL_API_KEY environment variable or pass apiKey.");
    }

    if (!_client || _client._apiKey !== key) {
      _client = new Firecrawl({ apiKey: key });
      _client._apiKey = key;
    }

    return _client;
  }

  async function scrapeUrl(url, { apiKey, formats = ["markdown"], onlyMainContent = true, waitFor = 0, timeout = 30000 } = {}) {
    const client = getClient(apiKey);

    const result = await client.scrapeUrl(url, {
      formats,
      onlyMainContent,
      waitFor,
      timeout,
    });

    const response = result.success ? result.data || result : result;

    return {
      success: result.success !== false,
      markdown: response?.markdown || "",
      html: response?.html || null,
      title: response?.metadata?.title || response?.title || "",
      url: response?.metadata?.sourceURL || url,
      error: result.error || null,
    };
  }

  async function extractStructuredData({ urls, prompt, schema, apiKey, timeout = 60000 } = {}) {
    const client = getClient(apiKey);

    const result = await client.extract({
      urls,
      prompt,
      schema,
      timeout,
    });

    return {
      success: result.success !== false,
      data: result.data || result,
      error: result.error || null,
    };
  }

  async function crawlSite(url, { apiKey, limit = 10, maxDepth = 2 } = {}) {
    const client = getClient(apiKey);

    const result = await client.crawlUrl(url, {
      limit,
      maxDepth,
      scrapeOptions: {
        formats: ["markdown"],
        onlyMainContent: true,
      },
    });

    return {
      success: result.success !== false,
      pages: result.data || result.pages || [],
      total: result.data?.length || result.total || 0,
      error: result.error || null,
    };
  }

  async function mapSite(url, { apiKey } = {}) {
    const client = getClient(apiKey);
    const result = await client.mapUrl(url);

    return {
      success: result.success !== false,
      urls: result.links || result.urls || [],
      error: result.error || null,
    };
  }

  async function batchScrape(urls, { apiKey, formats = ["markdown"], onlyMainContent = true } = {}) {
    const client = getClient(apiKey);

    const result = await client.batchScrape(urls, {
      formats,
      onlyMainContent,
    });

    return {
      success: result.success !== false,
      results: result.data || [],
      error: result.error || null,
    };
  }

  return {
    scrapeUrl,
    extractStructuredData,
    crawlSite,
    mapSite,
    batchScrape,
  };
}