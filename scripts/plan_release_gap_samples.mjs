#!/usr/bin/env node

import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const TRACKS = ['cet4', 'cet6'];
const DEFAULT_LIMIT = 12;
const DEFAULT_SAMPLE_SIZE = 3;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCED_SPECS = [
  '../softbook_cet/spec/requirement-memory.json',
  '../softbook_cet/spec/product-core.json',
  '../softbook_cet/spec/card-system.json',
  '../softbook_cet/spec/box-catalog.json',
  'spec/workspace-contract.json',
  'spec/content-quality-contract.json',
  'spec/review-workflow.json',
];

function parseArgs(argv) {
  const options = {
    cardMakeRoot: ROOT,
    contentGapReport: '',
    format: 'markdown',
    hideLocalSampleReady: false,
    includeCovered: false,
    limit: DEFAULT_LIMIT,
    output: '',
    sampleSize: DEFAULT_SAMPLE_SIZE,
    selfTest: false,
    track: 'both',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--content-gap-report':
        options.contentGapReport = requireNextValue(argv, index, arg);
        index += 1;
        break;
      case '--card-make-root':
        options.cardMakeRoot = resolve(requireNextValue(argv, index, arg));
        index += 1;
        break;
      case '--format':
        options.format = requireNextValue(argv, index, arg);
        index += 1;
        break;
      case '--hide-local-sample-ready':
        options.hideLocalSampleReady = true;
        break;
      case '--include-covered':
        options.includeCovered = true;
        break;
      case '--limit':
        options.limit = parsePositiveInteger(requireNextValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--output':
        options.output = requireNextValue(argv, index, arg);
        index += 1;
        break;
      case '--sample-size':
        options.sampleSize = parsePositiveInteger(requireNextValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--self-test':
        options.selfTest = true;
        break;
      case '--track':
        options.track = requireNextValue(argv, index, arg);
        index += 1;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['json', 'markdown'].includes(options.format)) {
    throw new Error('--format must be json or markdown.');
  }
  if (!['both', ...TRACKS].includes(options.track)) {
    throw new Error('--track must be cet4, cet6, or both.');
  }
  if (!options.selfTest && !options.contentGapReport) {
    throw new Error('--content-gap-report is required unless --self-test is used.');
  }

  return options;
}

function requireNextValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return number;
}

function printUsage() {
  console.log(`Usage: node scripts/plan_release_gap_samples.mjs --content-gap-report <json> [options]

Options:
  --card-make-root <dir>   Card make workspace root. Defaults to this repository.
  --format markdown|json   Output format. Defaults to markdown.
  --hide-local-sample-ready
                           Hide rows that already have a local 3-card self-review.
  --include-covered        Include boxes already covered by candidate projection.
  --limit <n>              Maximum target rows. Defaults to ${DEFAULT_LIMIT}.
  --output <path>          Write output to a file instead of stdout.
  --sample-size <n>        Candidate sample size per target box. Defaults to ${DEFAULT_SAMPLE_SIZE}.
  --track cet4|cet6|both   Track filter. Defaults to both.
  --self-test              Run built-in regression checks.

The input must be the JSON output from softbook_cet/scripts/report_release_content_gap.mjs.
This script only plans candidate sample targets; it does not generate, approve, import, or
mark cards formally usable.`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildCandidateProjectionMap(report) {
  const map = new Map();
  for (const row of report.candidate_handoff_delta?.rows || []) {
    if (row.track && row.prefix) {
      map.set(`${row.track}:${row.prefix}`, row);
    }
  }
  return map;
}

function trackList(track) {
  return track === 'both' ? TRACKS : [track];
}

function loadLocalCoverage(root) {
  const byKey = new Map();
  const cardDir = join(root, 'card_boxes_json');
  const selfReviewDir = join(root, 'reviews', 'agent_self_review');
  const approvalDir = join(root, 'reviews', 'approved_batches');

  if (existsSync(cardDir)) {
    for (const file of readdirSync(cardDir).filter(name => name.endsWith('.json')).sort()) {
      const payload = readJson(join(cardDir, file));
      for (const card of payload.cards || []) {
        const track = card.track || payload.track;
        const prefix = card.space_metadata?.box_ref ||
          card.knowledge_ref?.box_prefix ||
          card.card_box_code ||
          payload.card_box_code;

        if (!track || !prefix) continue;
        const record = ensureLocalRecord(byKey, track, prefix);
        record.local_candidate_cards += 1;
        if (record.local_sample_card_ids.length < DEFAULT_SAMPLE_SIZE) {
          record.local_sample_card_ids.push(card.card_id);
        }
      }
    }
  }

  if (existsSync(selfReviewDir)) {
    for (const file of readdirSync(selfReviewDir).filter(name => name.endsWith('.json')).sort()) {
      const review = readJson(join(selfReviewDir, file));
      const prefixes = review.scope?.box_prefixes || [];
      const isThreeCardSample = review.sample_policy?.is_three_card_sample_per_box === true;
      for (const prefix of prefixes) {
        const track = inferTrack(review, prefix);
        const record = ensureLocalRecord(byKey, track, prefix);
        record.local_self_review_records.push(review.review_id || file);
        if (isThreeCardSample) {
          record.local_three_card_self_reviews.push(review.review_id || file);
        }
      }
    }
  }

  if (existsSync(approvalDir)) {
    for (const file of readdirSync(approvalDir).filter(name => name.endsWith('.json') && name !== 'TEMPLATE.json').sort()) {
      const approval = readJson(join(approvalDir, file));
      const prefixes = approval.scope?.box_prefixes || approval.scope?.prefixes || [];
      for (const prefix of prefixes) {
        const track = approval.scope?.track || inferTrack(approval, prefix);
        const record = ensureLocalRecord(byKey, track, prefix);
        record.local_approved_batch_records.push(approval.approval_id || file);
      }
    }
  }

  return {byKey};
}

function ensureLocalRecord(byKey, track, prefix) {
  const key = `${track}:${prefix}`;
  if (!byKey.has(key)) {
    byKey.set(key, {
      local_candidate_cards: 0,
      local_sample_card_ids: [],
      local_self_review_records: [],
      local_three_card_self_reviews: [],
      local_approved_batch_records: [],
    });
  }
  return byKey.get(key);
}

function inferTrack(record, prefix) {
  const cardTrack = (record.cards || [])
    .map(card => card.track || card.knowledge_ref?.track)
    .find(Boolean);
  if (TRACKS.includes(cardTrack)) return cardTrack;
  return String(prefix).startsWith('1') ? 'cet6' : 'cet4';
}

function planTargets(report, options) {
  if (!Array.isArray(report.rows)) {
    throw new Error('Content gap report must include a rows array.');
  }

  const candidateProjection = buildCandidateProjectionMap(report);
  const localCoverage = options.localCoverage || loadLocalCoverage(options.cardMakeRoot);
  const targets = [];
  const selectedTracks = trackList(options.track);

  for (const row of report.rows) {
    for (const track of selectedTracks) {
      const prefix = row.prefixes?.[track];
      const planned = Number(row.planned?.[track] || 0);
      if (!prefix || planned <= 0) continue;

      const current = Number(row.current?.[track] || 0);
      const currentGap = Number(row.gap?.[track] ?? Math.max(0, planned - current));
      const projection = candidateProjection.get(`${track}:${prefix}`);
      const candidateNew = Number(projection?.candidate_new || 0);
      const projectedCurrent = projection
        ? Number(projection.projected_current || current + candidateNew)
        : current;
      const projectedGap = projection
        ? Number(projection.projected_gap ?? Math.max(0, planned - projectedCurrent))
        : currentGap;
      const planningGap = projectedGap;
      const local = localCoverage.byKey.get(`${track}:${prefix}`) || emptyLocalRecord();
      const localStatus = localCandidateStatus(local, options.sampleSize);

      if (planningGap <= 0 && !options.includeCovered) continue;
      if (currentGap <= 0 && !options.includeCovered) continue;
      if (options.hideLocalSampleReady && local.local_three_card_self_reviews.length > 0) continue;

      targets.push({
        track,
        prefix,
        library: row.library,
        group: row.group,
        box: row.box,
        planned_cards: planned,
        current_runtime_cards: current,
        current_gap: currentGap,
        candidate_new_cards: candidateNew,
        local_candidate_cards: local.local_candidate_cards,
        local_sample_card_ids: local.local_sample_card_ids,
        local_self_review_records: local.local_self_review_records,
        local_three_card_self_reviews: local.local_three_card_self_reviews,
        local_approved_batch_records: local.local_approved_batch_records,
        local_candidate_status: localStatus.status,
        projected_current_cards: projectedCurrent,
        projected_gap: projectedGap,
        planning_gap: planningGap,
        sample_size: Math.min(options.sampleSize, Math.max(1, planningGap || currentGap)),
        priority_reason: priorityReason(current, candidateNew, projectedGap),
        review_workflow: localStatus.next_step,
        boundary: 'candidate planning only; no reviews/approved_batches record and no formal content approval',
      });
    }
  }

  return targets.slice(0, options.limit);
}

function emptyLocalRecord() {
  return {
    local_candidate_cards: 0,
    local_sample_card_ids: [],
    local_self_review_records: [],
    local_three_card_self_reviews: [],
    local_approved_batch_records: [],
  };
}

function localCandidateStatus(local, sampleSize) {
  if (local.local_approved_batch_records.length > 0) {
    return {
      status: 'user_approved_batch_recorded',
      next_step: 'use approved-batch scope for formal import planning; do not regenerate candidate samples',
    };
  }
  if (local.local_three_card_self_reviews.length > 0) {
    return {
      status: 'local_three_card_sample_reviewed_waiting_user_confirmation',
      next_step: 'present existing reviewed 3-card sample for user confirmation before batch expansion or formal import',
    };
  }
  if (local.local_candidate_cards >= sampleSize) {
    return {
      status: 'local_candidates_need_agent_self_review',
      next_step: 'create or refresh a scoped 3-card self-review record, then wait for user confirmation',
    };
  }
  if (local.local_candidate_cards > 0) {
    return {
      status: 'partial_local_candidates_need_sample_completion',
      next_step: 'complete the local candidate set to a 3-card sample, run scoped audit and agent self-review, then wait for user confirmation',
    };
  }
  return {
    status: 'no_local_candidates',
    next_step: 'produce a 3-card candidate sample, run scoped audit and agent self-review, then wait for user confirmation before batch expansion',
  };
}

function priorityReason(current, candidateNew, projectedGap) {
  if (candidateNew > 0 && projectedGap > 0) {
    return 'candidate handoff partly covers this box, but projected gap remains';
  }
  if (candidateNew > 0 && projectedGap <= 0) {
    return 'candidate handoff dry-run covers the current catalog gap';
  }
  if (current === 0) {
    return 'no current runtime cards mapped to this box';
  }
  return 'runtime catalog gap remains';
}

function summarizePlan(report, targets) {
  const byTrack = {};
  for (const track of TRACKS) {
    const trackTargets = targets.filter(target => target.track === track);
    const sourceSummary = report.summary?.[track] || {};
    const candidateSummary = report.candidate_handoff_delta?.summary?.[track] || {};
    const plannedSampleCards = trackTargets.reduce((sum, target) => sum + target.sample_size, 0);
    const startingFreeGap = candidateSummary.projected_free_target_gap ?? sourceSummary.free_target_gap ?? null;
    const localStatusCounts = countBy(trackTargets, target => target.local_candidate_status);

    byTrack[track] = {
      target_boxes: trackTargets.length,
      planned_sample_cards: plannedSampleCards,
      current_free_target_gap: sourceSummary.free_target_gap ?? null,
      candidate_projected_free_target_gap: candidateSummary.projected_free_target_gap ?? null,
      projected_free_target_gap_after_samples: startingFreeGap === null
        ? null
        : Math.max(0, startingFreeGap - plannedSampleCards),
      local_status_counts: localStatusCounts,
    };
  }
  return byTrack;
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function buildPlan(report, options, sourcePath = '') {
  const targets = planTargets(report, options);
  return {
    generated_at: new Date().toISOString(),
    source_report: sourcePath,
    referenced_specs: REFERENCED_SPECS,
    product_truth: 'Apple release content must map to the active softbook_cet box catalog and formal usability still requires explicit user approval.',
    implementation_hypothesis: 'This plan translates a release content gap report into card make sample-review targets and cross-checks local candidate coverage. Candidate projections are dry-run planning evidence only.',
    sample_policy: {
      default_sample_size: options.sampleSize,
      batch_generation_requires_user_confirmation: true,
      approval_records_written: false,
      formal_content_claimed: false,
    },
    plan_summary: summarizePlan(report, targets),
    targets,
  };
}

function renderMarkdown(plan) {
  const lines = [];
  lines.push('# Release Gap Sample Plan');
  lines.push('');
  lines.push(`Generated at: \`${plan.generated_at}\``);
  lines.push('');
  lines.push(`Source report: \`${plan.source_report || 'self-test'}\``);
  lines.push('');
  lines.push(`\`product_truth\`: ${plan.product_truth}`);
  lines.push('');
  lines.push(`\`implementation_hypothesis\`: ${plan.implementation_hypothesis}`);
  lines.push('');
  lines.push('## Sample Boundary');
  lines.push('');
  lines.push(`- Default sample size: ${plan.sample_policy.default_sample_size} cards per box.`);
  lines.push('- This plan does not generate cards, approve content, import payloads, or write `reviews/approved_batches/` records.');
  lines.push('- Batch expansion still requires user confirmation of a reviewed 3-card sample.');
  lines.push('');
  lines.push('## Track Summary');
  lines.push('');
  lines.push('| Track | Target boxes | Planned sample cards | Current free-target gap | Candidate-projected free-target gap | Projected gap after these samples | Local reviewed samples | Local candidates needing review | No local candidates |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const track of TRACKS) {
    const row = plan.plan_summary[track];
    lines.push(`| ${track.toUpperCase()} | ${row.target_boxes} | ${row.planned_sample_cards} | ${nullable(row.current_free_target_gap)} | ${nullable(row.candidate_projected_free_target_gap)} | ${nullable(row.projected_free_target_gap_after_samples)} | ${row.local_status_counts.local_three_card_sample_reviewed_waiting_user_confirmation || 0} | ${row.local_status_counts.local_candidates_need_agent_self_review || 0} | ${row.local_status_counts.no_local_candidates || 0} |`);
  }
  lines.push('');
  lines.push('## Next Sample Targets');
  lines.push('');
  lines.push('| # | Track | Prefix | Library | Group | Box | Runtime current | Local candidates | Local status | Candidate new | Planning gap | Sample size | Next step |');
  lines.push('| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |');
  plan.targets.forEach((target, index) => {
    lines.push(`| ${index + 1} | ${target.track.toUpperCase()} | ${target.prefix} | ${target.library} | ${target.group} | ${target.box} | ${target.current_runtime_cards} | ${target.local_candidate_cards} | ${target.local_candidate_status} | ${target.candidate_new_cards} | ${target.planning_gap} | ${target.sample_size} | ${target.review_workflow} |`);
  });
  return `${lines.join('\n')}\n`;
}

function nullable(value) {
  return value === null || value === undefined ? '-' : String(value);
}

function writeOutput(options, content) {
  if (!options.output) {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(resolve(options.output)), {recursive: true});
  writeFileSync(options.output, content);
  console.log(`[ok] wrote release gap sample plan to ${options.output}`);
}

function runSelfTest() {
  const report = {
    rows: [
      {
        library: '听力',
        group: '听前预测',
        box: '根据选项预测话题',
        prefixes: {cet4: '0000', cet6: '1000'},
        planned: {cet4: 12, cet6: 12},
        current: {cet4: 0, cet6: 0},
        gap: {cet4: 12, cet6: 12},
      },
      {
        library: '词汇',
        group: '同义词替换',
        box: '词性转换',
        prefixes: {cet6: '1501'},
        planned: {cet4: 0, cet6: 12},
        current: {cet4: 0, cet6: 0},
        gap: {cet4: 0, cet6: 12},
      },
    ],
    summary: {
      cet4: {free_target_gap: 590},
      cet6: {free_target_gap: 617},
    },
    candidate_handoff_delta: {
      rows: [
        {
          track: 'cet6',
          prefix: '1501',
          candidate_new: 12,
          projected_current: 12,
          projected_gap: 0,
        },
      ],
      summary: {
        cet6: {projected_free_target_gap: 605},
      },
    },
  };

  const plan = buildPlan(report, {
    format: 'json',
    includeCovered: false,
    localCoverage: {byKey: new Map()},
    limit: 10,
    sampleSize: 3,
    track: 'both',
  }, 'fixture.json');

  assert.equal(plan.targets.length, 2);
  assert.equal(plan.targets[0].prefix, '0000');
  assert.equal(plan.targets[1].prefix, '1000');
  assert.equal(plan.plan_summary.cet4.planned_sample_cards, 3);
  assert.equal(plan.plan_summary.cet6.planned_sample_cards, 3);

  const coveredPlan = buildPlan(report, {
    format: 'json',
    includeCovered: true,
    localCoverage: {byKey: new Map()},
    limit: 10,
    sampleSize: 3,
    track: 'cet6',
  }, 'fixture.json');
  assert.equal(coveredPlan.targets.some(target => target.prefix === '1501'), true);
  assert.equal(renderMarkdown(plan).includes('reviews/approved_batches'), true);

  const localCoverage = {
    byKey: new Map([
      ['cet4:0000', {
        local_candidate_cards: 12,
        local_sample_card_ids: ['000001', '000002', '000003'],
        local_self_review_records: ['fixture-review'],
        local_three_card_self_reviews: ['fixture-review'],
        local_approved_batch_records: [],
      }],
    ]),
  };
  const localPlan = buildPlan(report, {
    format: 'json',
    includeCovered: false,
    localCoverage,
    limit: 10,
    sampleSize: 3,
    track: 'cet4',
  }, 'fixture.json');
  assert.equal(localPlan.targets[0].local_candidate_cards, 12);
  assert.equal(
    localPlan.targets[0].local_candidate_status,
    'local_three_card_sample_reviewed_waiting_user_confirmation',
  );

  const hiddenLocalPlan = buildPlan(report, {
    format: 'json',
    hideLocalSampleReady: true,
    includeCovered: false,
    localCoverage,
    limit: 10,
    sampleSize: 3,
    track: 'cet4',
  }, 'fixture.json');
  assert.equal(hiddenLocalPlan.targets.length, 0);
  console.log('[ok] plan_release_gap_samples self-test passed');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }

  const resolvedReportPath = resolve(options.contentGapReport);
  const report = readJson(resolvedReportPath);
  const plan = buildPlan(report, options, resolvedReportPath);
  const content = options.format === 'json'
    ? `${JSON.stringify(plan, null, 2)}\n`
    : renderMarkdown(plan);
  writeOutput(options, content);
}

try {
  main();
} catch (error) {
  console.error(`[release-gap-sample-plan] ${error.message}`);
  process.exit(1);
}
