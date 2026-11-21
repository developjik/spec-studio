#!/usr/bin/env node
/**
 * spec-studio · journey report (AC-1 / F0-6)
 *
 * Reads the `journey.mark` events the store stamps next to every core
 * milestone — attach → capture → brief → promote → package — and prints the
 * stage-by-stage timing of each project journey in the database. The marks
 * carry `elapsedMs` measured off event timestamps; this script adds nothing
 * to the schema and opens the file read-only.
 *
 * Usage:
 *   pnpm journey:report -- <path-to-graph.db>
 *   SPEC_STUDIO_DB=.e2e-e1/graph.db pnpm journey:report
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const STAGE_ORDER = ['attach', 'capture', 'brief', 'promote', 'package'];
const STAGE_LABEL = {
  attach: '화면 등록',
  capture: '아이디어 캡처',
  brief: '브리프 채택',
  promote: '스펙 승격',
  package: '패키지 내보내기',
};
/** The acceptance bar the design sets for the whole onboarding journey. */
const BUDGET_MS = 10 * 60 * 1000;

const dbPath = resolve(
  process.argv[2] ?? process.env.SPEC_STUDIO_DB ?? '.data/spec-studio.db',
);

if (!existsSync(dbPath)) {
  console.error(`데이터베이스를 찾지 못했습니다: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const marks = db
    .prepare(
      `SELECT thread_id, seq, payload, at FROM event
        WHERE type = 'journey.mark' ORDER BY thread_id, seq`,
    )
    .all();

  const projects = db
    .prepare('SELECT id, name, created_at FROM project ORDER BY created_at')
    .all();
  const nameOf = new Map(projects.map((row) => [`project:${row.id}`, row.name]));

  if (marks.length === 0) {
    console.log(`${dbPath} — 아직 journey.mark 이벤트가 없습니다.`);
    console.log('화면 등록 → 캡처 → 브리프 → 승격 → 패키지를 한 번 지나면 기록됩니다.');
    process.exit(0);
  }

  const journeys = new Map();
  for (const row of marks) {
    if (!journeys.has(row.thread_id)) journeys.set(row.thread_id, []);
    journeys.get(row.thread_id).push({ seq: row.seq, at: row.at, ...JSON.parse(row.payload) });
  }

  const fmt = (ms) =>
    ms >= 60000 ? `${(ms / 60000).toFixed(1)}분` : `${(ms / 1000).toFixed(1)}초`;

  for (const [threadId, rows] of journeys) {
    const name = nameOf.get(threadId) ?? threadId;
    console.log(`\n프로젝트: ${name} (${threadId})`);
    console.log('  단계                     시각                         소요');
    for (const mark of rows) {
      const label = (STAGE_LABEL[mark.stage] ?? mark.stage).padEnd(20, ' ');
      console.log(`  ${label}   ${mark.at}   +${fmt(mark.elapsedMs)}`);
    }
    const first = Date.parse(rows[0].at);
    const last = Date.parse(rows.at(-1).at);
    const total = Math.max(0, last - first);
    const done = rows.filter((mark) => STAGE_ORDER.includes(mark.stage)).length;
    const verdict =
      rows.some((mark) => mark.stage === 'package')
        ? total <= BUDGET_MS
          ? `전체 ${fmt(total)} — 10분 기준 충족`
          : `전체 ${fmt(total)} — 10분 기준 초과`
        : `진행 중 — ${done}/${STAGE_ORDER.length} 단계 (첫 마크 이후 ${fmt(total)})`;
    console.log(`  → ${verdict}`);
  }

  console.log(`\n요약: ${journeys.size}개 여정 · ${marks.length}개 마크`);
} finally {
  db.close();
}
