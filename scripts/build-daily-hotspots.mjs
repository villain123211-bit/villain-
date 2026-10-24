#!/usr/bin/env node
/*
 * TRAEWork 每日热点数据构建器
 *
 * 1) 从公开 RSS 生成候选，不直接发布；
 * 2) 仅发布 data/reviewed-hotspots.json 中满足来源、日期、玩法字段校验的条目；
 * 3) 发布物写入仓库根目录 data 与本地工作副本，供静态 PWA 使用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'hotspot-sources.json');
const reviewedPath = path.join(root, 'data', 'reviewed-hotspots.json');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const outputs = [
  path.join(root, 'data', 'hotspots.json'),
  path.join(root, 'work', 'traework', 'data', 'hotspots.json'),
  path.join(root, 'outputs', 'data', 'hotspots.json')
];
const ALLOWED_ZONES = new Set(['cn', 'global', 'aiCN', 'aiGL']);
const ALLOWED_PLATFORMS = new Set(['douyin', 'xhs', 'weibo', 'tiktok', 'ins', 'x', 'ai', 'github']);

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
const decode = value => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const field = (xml, name) => decode((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')) || [])[1]).trim();
const isoDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
};
const normalizeTitle = title => title.replace(/\s+-\s+[^-]{1,80}$/, '').replace(/\s+/g, ' ').trim();

function isRecent(date, windowDays) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(date + 'T00:00:00');
  const age = Math.floor((today - target) / 86400000);
  return age >= 0 && age < windowDays;
}

async function collectCandidates(config) {
  const all = [];
  for (const source of config.sources) {
    try {
      const response = await fetch(source.url, { headers: { 'user-agent': 'TRAEWork-hotspot-verifier/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await response.text();
      for (const item of xml.match(/<item>[\s\S]*?<\/item>/gi) || []) {
        const date = isoDate(field(item, 'pubDate'));
        const url = field(item, 'link');
        const title = normalizeTitle(field(item, 'title'));
        if (!date || !url || !title || !isRecent(date, config.windowDays)) continue;
        all.push({
          candidateId: `${source.id}:${date}:${title}`.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').slice(0, 160),
          date, title, url, source: source.label, zone: source.zone, plat: source.platform,
          summary: field(item, 'description'),
          status: 'needs_review',
          reason: '已满足时间和来源 URL 条件；仍需人工或受控 AI 核验内容运营价值、玩法和平台归属。'
        });
      }
    } catch (error) {
      all.push({ source: source.label, status: 'source_error', reason: String(error.message || error) });
    }
  }
  const seen = new Set();
  return all.filter(item => {
    if (item.status !== 'needs_review') return true;
    const key = `${item.date}|${item.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function validateReviewedItem(item, windowDays) {
  const required = ['zone', 'plat', 'date', 'title', 'url', 'src', 'why', 'idea'];
  for (const key of required) if (!String(item[key] || '').trim()) return `${key} 不能为空`;
  if (!ALLOWED_ZONES.has(item.zone)) return 'zone 不合法';
  if (!ALLOWED_PLATFORMS.has(item.plat)) return 'plat 不合法';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !isRecent(item.date, windowDays)) return '日期不在最近 7 天内';
  if (!/^https:\/\//i.test(item.url)) return '出处必须为 HTTPS URL';
  if (!Array.isArray(item.tags) || !item.tags.length) return '至少需要一个 tags 标签';
  if (item.zone === 'global' && !/^https:\/\//i.test(item.mirrorUrl || '')) return '国外热点必须有国内可查证 mirrorUrl';
  return null;
}

function toCard(item) {
  const platformLists = { douyin:['douyin'], xhs:['xhs'], weibo:['weibo'], tiktok:['tiktok'], ins:['ins'], x:['x'], ai:['ai'], github:['github'] };
  return {
    plat: item.plat,
    plats: item.plats || platformLists[item.plat] || [item.plat],
    date: item.date,
    heatNum: Number(item.heatNum || 0),
    fitScore: Number(item.fitScore || item.heatNum || 0),
    kw: item.kw || item.title,
    track: item.track || '内容运营',
    title: item.title,
    url: item.url,
    webUrl: item.webUrl || item.url,
    mirrorUrl: item.mirrorUrl || '',
    src: item.src,
    why: item.why,
    idea: item.idea,
    plan: Array.isArray(item.plan) && item.plan.length ? item.plan : [item.idea],
    tags: item.tags
  };
}

async function main() {
  const config = await readJson(configPath);
  const candidates = await collectCandidates(config);
  await writeJson(candidatesPath, {
    schemaVersion: 1, generatedAt: new Date().toISOString(), windowDays: config.windowDays,
    candidates
  });

  const reviewed = await readJson(reviewedPath);
  const accepted = [];
  const rejected = [];
  for (const item of reviewed.items || []) {
    const error = validateReviewedItem(item, config.windowDays);
    if (error) rejected.push({ title: item.title || '', reason: error });
    else accepted.push(item);
  }
  if (!accepted.length) {
    console.log(`已生成 ${candidates.length} 条候选；没有通过全部字段校验的已审核条目，因此没有覆盖线上热点数据。`);
    if (rejected.length) console.log('已拒绝：', rejected);
    return;
  }
  const collections = { cnTopics: [], cnHot: [], glTopics: [], aiCN: [], aiGL: [] };
  for (const item of accepted) {
    const card = toCard(item);
    if (item.zone === 'cn') { collections.cnTopics.push(card); collections.cnHot.push(card); }
    if (item.zone === 'global') collections.glTopics.push(card);
    if (item.zone === 'aiCN') collections.aiCN.push(card);
    if (item.zone === 'aiGL') collections.aiGL.push(card);
  }
  const latestDate = accepted.map(x => x.date).sort().at(-1);
  const published = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    latestDate,
    windowDays: config.windowDays,
    collections
  };
  await Promise.all(outputs.map(file => writeJson(file, published)));
  console.log(`已发布 ${accepted.length} 条已核验热点，资料截至 ${latestDate}。`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

