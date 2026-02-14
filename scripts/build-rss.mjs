import { fetch } from "undici";
import RSS from "rss";
import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";

const OUT_FILE = "rss.xml";
const MAX_ITEMS = 5;

// Google News sitemap (latest ~2 days)
const NEWS_SITEMAP = "https://www.tmz.com/sitemaps/news.xml";

const UA = "tmz-top5-rss/1.3 (GitHub Actions; personal use)";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false
});

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "text/html,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

async function getLatestNewsItems() {
  const xml = await fetchText(NEWS_SITEMAP);
  const obj = parser.parse(xml);

  const urlset = obj?.urlset?.url;
  const items = [];

  for (const u of asArray(urlset)) {
    const loc = u?.loc;
    const news = u?.["news:news"];
    const title = news?.["news:title"];
    const pubDate = news?.["news:publication_date"];

    if (typeof loc !== "string") continue;
    if (typeof title !== "string") continue;

    items.push({
      url: loc.trim(),
      title: title.trim(),
      pubDate: typeof pubDate === "string" ? pubDate : null
    });
  }

  return items;
}

function normalizeImageUrl(url) {
  if (!url) return null;
  // Some og:image values can be protocol-relative
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

async function getOgImage(articleUrl) {
  const html = await fetchText(articleUrl);
  const $ = cheerio.load(html);

  // Best: OpenGraph
  let img =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('meta[property="og:image:secure_url"]').attr("content");

  img = normalizeImageUrl(img);
  if (img) return img;

  // Fallback: first big-looking img
  const firstImg = $("img").first().attr("src");
  return normalizeImageUrl(firstImg);
}

function guessImageType(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

async function main() {
  const newsItems = await getLatestNewsItems();

  // We’ll try up to 25 recent items to find 5 that successfully return an og:image
  const chosen = [];
  const toTry = newsItems.slice(0, 25);

  for (const item of toTry) {
    try {
      const image = await getOgImage(item.url);
      if (!image) continue;

      chosen.push({ ...item, image });
      if (chosen.length >= MAX_ITEMS) break;

      // small delay to be polite (and reduce bot flags)
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      // Skip items that fail (403/timeout/etc.)
    }
  }

  if (chosen.length < MAX_ITEMS) {
    throw new Error(
      `Only found ${chosen.length}/${MAX_ITEMS} items with images. TMZ may be blocking article-page fetches from GitHub Actions.`
    );
  }

  const feed = new RSS({
    title: "TMZ – Top 5 (Unofficial)",
    description: "Top 5 TMZ items (title + link + photo) built from TMZ news sitemap + OG images.",
    site_url: "https://www.tmz.com/",
    language: "en",
    ttl: 30,
    custom_namespaces: { media: "http://search.yahoo.com/mrss/" }
  });

  for (const item of chosen) {
    const date = item.pubDate ? new Date(item.pubDate) : new Date();

    feed.item({
      title: item.title,
      url: item.url,
      guid: item.url,
      date,
      enclosure: { url: item.image, type: guessImageType(item.image) },
      custom_elements: [
        { "media:content": [{ _attr: { url: item.image, medium: "image" } }] },
        { "media:thumbnail": [{ _attr: { url: item.image } }] }
      ]
    });
  }

  await fs.writeFile(OUT_FILE, feed.xml({ indent: true }), "utf8");
  console.log(`Wrote ${OUT_FILE} with ${chosen.length} items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});