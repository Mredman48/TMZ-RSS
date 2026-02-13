import { fetch } from "undici";
import * as cheerio from "cheerio";
import RSS from "rss";
import fs from "node:fs/promises";

const OUT_FILE = "rss.xml";
const MAX_ITEMS = 5;

// TMZ publishes these XML endpoints (linked in footer + robots)
const UPDATED_ARTICLE_SITEMAP_INDEX = "https://www.tmz.com/sitemaps/article/updated/index.xml";
const FALLBACK_ARTICLE_SITEMAP_INDEX = "https://www.tmz.com/sitemaps/article/index.xml";

const UA = "tmz-top5-rss/1.1 (GitHub Actions; personal use)";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "application/xml,text/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

function parseSitemapIndex(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemaps = [];

  $("sitemap").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    const lastmod = $(el).find("lastmod").text().trim();
    if (loc) sitemaps.push({ loc, lastmod });
  });

  // Sort newest first by lastmod if present, otherwise keep original order.
  sitemaps.sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""));
  return sitemaps.map(s => s.loc);
}

function parseArticleSitemap(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $("url").each((_, el) => {
    const loc = $(el).find("loc").first().text().trim();
    if (!loc) return;

    // Image namespaces often appear as image:image / image:loc (Google image sitemap format)
    // Cheerio in xmlMode still finds them by tag name.
    const imageLoc =
      $(el).find("image\\:image image\\:loc").first().text().trim() ||
      $(el).find("image\\:loc").first().text().trim() ||
      "";

    if (imageLoc) {
      items.push({ url: loc, image: imageLoc });
    }
  });

  return items;
}

function guessImageType(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

async function main() {
  let indexXml;
  try {
    indexXml = await fetchText(UPDATED_ARTICLE_SITEMAP_INDEX);
  } catch (e) {
    // Fallback if updated index is unavailable
    indexXml = await fetchText(FALLBACK_ARTICLE_SITEMAP_INDEX);
  }

  const sitemapUrls = parseSitemapIndex(indexXml);
  if (!sitemapUrls.length) throw new Error("No sitemaps found in sitemap index.");

  // Grab the newest sitemap file
  const newestSitemapUrl = sitemapUrls[0];
  const articleXml = await fetchText(newestSitemapUrl);

  const articleItems = parseArticleSitemap(articleXml);

  // Need top 5 with images (your requirement)
  const top = articleItems.slice(0, MAX_ITEMS);
  if (top.length < MAX_ITEMS) {
    throw new Error(`Only found ${top.length}/${MAX_ITEMS} items with images in sitemap.`);
  }

  const feed = new RSS({
    title: "TMZ – Top 5 (Unofficial)",
    description: "Top 5 TMZ articles with photos (built from TMZ sitemap XML).",
    feed_url: "https://example.com/rss.xml",
    site_url: "https://www.tmz.com/",
    language: "en",
    ttl: 30,
    custom_namespaces: {
      media: "http://search.yahoo.com/mrss/"
    }
  });

  for (const item of top) {
    // Title isn’t in the sitemap, so use a clean fallback:
    // You can optionally fetch each article page later (may 403) to get real titles.
    const fallbackTitle = item.url.split("/").filter(Boolean).slice(-1)[0].replace(/-/g, " ");

    feed.item({
      title: fallbackTitle,
      url: item.url,
      guid: item.url,
      date: new Date(),
      enclosure: { url: item.image, type: guessImageType(item.image) },
      custom_elements: [
        { "media:content": [{ _attr: { url: item.image, medium: "image" } }] },
        { "media:thumbnail": [{ _attr: { url: item.image } }] }
      ]
    });
  }

  await fs.writeFile(OUT_FILE, feed.xml({ indent: true }), "utf8");
  console.log(`Wrote ${OUT_FILE} with ${top.length} items from ${newestSitemapUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});