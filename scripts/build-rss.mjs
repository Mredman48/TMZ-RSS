import { fetch } from "undici";
import * as cheerio from "cheerio";
import RSS from "rss";
import fs from "node:fs/promises";

const SITE_URL = "https://www.tmz.com/";
const OUT_FILE = "rss.xml";
const MAX_ITEMS = 5;

const UA = "tmz-top5-rss/1.0 (GitHub Actions; personal use)";

function pickImageUrl($img) {
  const src = $img.attr("src");
  const dataSrc = $img.attr("data-src");
  const srcSet = $img.attr("srcset");

  const candidate = dataSrc || src;
  if (candidate && candidate.startsWith("http")) return candidate;

  if (srcSet) {
    const first = srcSet.split(",")[0]?.trim()?.split(" ")[0];
    if (first && first.startsWith("http")) return first;
  }
  return null;
}

function isLikelyStoryUrl(url) {
  return (
    url.startsWith("https://www.tmz.com/") &&
    (/\/\d{4}\/\d{2}\/\d{2}\//.test(url) || url.includes("/categories/"))
  );
}

async function getHomepageHtml() {
  const res = await fetch(SITE_URL, {
    headers: { "user-agent": UA, accept: "text/html,*/*" }
  });
  if (!res.ok) throw new Error(`Homepage fetch failed: ${res.status}`);
  return await res.text();
}

function extractTopStories(html) {
  const $ = cheerio.load(html);

  const seen = new Set();
  const items = [];

  $("a[href]").each((_, a) => {
    if (items.length >= MAX_ITEMS) return;

    const href = $(a).attr("href");
    if (!href) return;

    const absUrl = href.startsWith("http") ? href : `https://www.tmz.com${href}`;
    if (!isLikelyStoryUrl(absUrl)) return;
    if (seen.has(absUrl)) return;

    const title = $(a).text().trim().replace(/\s+/g, " ");
    if (!title || title.length < 8) return;

    let imgUrl = null;

    const nestedImg = $(a).find("img").first();
    if (nestedImg.length) imgUrl = pickImageUrl(nestedImg);

    if (!imgUrl) {
      const container = $(a).closest("article, li, div");
      const nearImg = container.find("img").first();
      if (nearImg.length) imgUrl = pickImageUrl(nearImg);
    }

    if (!imgUrl) return;

    seen.add(absUrl);
    items.push({ title, url: absUrl, image: imgUrl });
  });

  return items.slice(0, MAX_ITEMS);
}

function guessImageType(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

async function main() {
  const html = await getHomepageHtml();
  const items = extractTopStories(html);

  if (items.length < MAX_ITEMS) {
    throw new Error(
      `Only found ${items.length}/${MAX_ITEMS} items with images. TMZ markup likely changed—adjust heuristics.`
    );
  }

  const feed = new RSS({
    title: "TMZ – Top 5 (Unofficial)",
    description: "Top 5 TMZ homepage stories (title + link + photo). Unofficial feed.",
    feed_url: `${SITE_URL}rss.xml`,
    site_url: SITE_URL,
    language: "en",
    ttl: 30,
    custom_namespaces: { media: "http://search.yahoo.com/mrss/" }
  });

  for (const item of items) {
    feed.item({
      title: item.title,
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
  console.log(`Wrote ${OUT_FILE} with ${items.length} items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});