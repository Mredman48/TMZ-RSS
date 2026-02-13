import { fetch } from "undici";
import RSS from "rss";
import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

const OUT_FILE = "rss.xml";
const MAX_ITEMS = 5;

const NEWS_SITEMAP = "https://www.tmz.com/sitemaps/news.xml";
const IMAGE_SITEMAP_INDEX = "https://www.tmz.com/sitemaps/image/index.xml";

const UA = "tmz-top5-rss/1.2 (GitHub Actions; personal use)";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Preserve namespaced tags like news:title, image:image
  removeNSPrefix: false
});

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "application/xml,text/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function pickFirstImageLoc(imageNode) {
  // imageNode can be:
  // - { "image:loc": "..." }
  // - { "image:loc": { "#text": "..." } }
  // - etc.
  const loc = imageNode?.["image:loc"];
  if (!loc) return null;
  if (typeof loc === "string") return loc;
  if (typeof loc === "object" && typeof loc["#text"] === "string") return loc["#text"];
  return null;
}

async function buildImageMapFromLatestSitemaps() {
  const indexXml = await fetchText(IMAGE_SITEMAP_INDEX);
  const indexObj = parser.parse(indexXml);

  const sitemapIndex = indexObj?.sitemapindex?.sitemap;
  const sitemaps = asArray(sitemapIndex)
    .map((s) => ({
      loc: s?.loc,
      lastmod: s?.lastmod || ""
    }))
    .filter((s) => typeof s.loc === "string" && s.loc.startsWith("http"));

  if (!sitemaps.length) throw new Error("No image sitemaps found in image index.");

  // Newest first (string compare works for ISO-ish)
  sitemaps.sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""));

  // Pull the newest 2 image sitemaps to increase chance of covering the latest news URLs
  const toFetch = sitemaps.slice(0, 2).map((s) => s.loc);

  const map = new Map(); // url -> image url

  for (const sitemapUrl of toFetch) {
    const xml = await fetchText(sitemapUrl);
    const obj = parser.parse(xml);

    const urlset = obj?.urlset?.url;
    for (const u of asArray(urlset)) {
      const pageUrl = u?.loc;
      if (typeof pageUrl !== "string") continue;

      // image:image can be a single object or array
      const imageNodes = asArray(u?.["image:image"]);
      if (!imageNodes.length) continue;

      const firstLoc = pickFirstImageLoc(imageNodes[0]);
      if (!firstLoc) continue;

      // only set if not already set (keep the first seen)
      if (!map.has(pageUrl)) map.set(pageUrl, firstLoc);
    }
  }

  return map;
}

async function getLatestNewsItems() {
  const newsXml = await fetchText(NEWS_SITEMAP);
  const newsObj = parser.parse(newsXml);

  const urlset = newsObj?.urlset?.url;
  const items = [];

  for (const u of asArray(urlset)) {
    const loc = u?.loc;
    const news = u?.["news:news"];
    const title = news?.["news:title"];
    const pubDate = news?.["news:publication_date"];

    if (typeof loc !== "string") continue;
    if (typeof title !== "string") continue;

    items.push({
      url: loc,
      title: title.trim(),
      pubDate: typeof pubDate === "string" ? pubDate : null
    });
  }

  return items;
}

function guessImageType(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

async function main() {
  const [newsItems, imageMap] = await Promise.all([
    getLatestNewsItems(),
    buildImageMapFromLatestSitemaps()
  ]);

  // Select the first MAX_ITEMS news URLs that have an image in the map
  const chosen = [];
  for (const n of newsItems) {
    const img = imageMap.get(n.url);
    if (!img) continue;
    chosen.push({ ...n, image: img });
    if (chosen.length >= MAX_ITEMS) break;
  }

  if (chosen.length < MAX_ITEMS) {
    throw new Error(
      `Only found ${chosen.length}/${MAX_ITEMS} latest news items with images via image sitemap.`
    );
  }

  const feed = new RSS({
    title: "TMZ – Top 5 (Unofficial)",
    description:
      "Top 5 TMZ items (title + link + photo) built from TMZ news + image sitemaps.",
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