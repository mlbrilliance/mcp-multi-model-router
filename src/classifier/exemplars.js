// Labeled exemplars for embedding-kNN classification.
// Each entry mirrors the {intent, taskType, agent} shape used by classifyIntent
// and adds a complexity label (0-10) for the kNN-derived complexity scorer.
//
// Bootstrap source: paraphrases of phrases from INTENT_TRIGGERS (index.js:1656)
// and COMPLEXITY_INDICATORS (index.js:1400). Phase 3 will replace this with
// distilled traces from QualityTracker.
//
// Convention: keep entries ≤ 30 per intent; lowercase; trim trailing punctuation.

export const EXEMPLARS = [
  // write-tests / test-engineer
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 4, prompt: 'write unit tests for the parser module' },
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 4, prompt: 'add test coverage for the auth flow' },
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 5, prompt: 'write integration tests covering the api endpoints' },
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 3, prompt: 'add a pytest fixture for the user model' },
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 5, prompt: 'write an end-to-end test for the checkout flow' },
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 4, prompt: 'cover the edge cases in the rate limiter with tests' },
  { intent: 'write-tests', taskType: 'test', agent: 'test-engineer', complexity: 3, prompt: 'write a regression test for the bug we just fixed' },

  // fix-bug / debugger
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 5, prompt: 'fix the bug where login fails with special characters' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 6, prompt: 'debug this regression in the user session handler' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 5, prompt: 'the api is returning 500 on this request, figure out why' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 6, prompt: 'investigate why the integration test is flaky' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 5, prompt: 'something is broken in the checkout flow, track it down' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 7, prompt: 'reproduce and fix the intermittent crash in the worker pool' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 4, prompt: 'fix the failing build on the ci pipeline' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 6, prompt: 'look for a regression in this commit that broke production' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 5, prompt: 'why is the endpoint returning a 500 response' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 5, prompt: 'track down why this test keeps flaking in ci' },
  { intent: 'fix-bug', taskType: 'debug', agent: 'debugger', complexity: 6, prompt: 'figure out what is causing the worker to hang' },

  // security-review / security-auditor
  { intent: 'security-review', taskType: 'security', agent: 'security-auditor', complexity: 7, prompt: 'review this code for security vulnerabilities' },
  { intent: 'security-review', taskType: 'security', agent: 'security-auditor', complexity: 7, prompt: 'audit the auth middleware for owasp top 10 issues' },
  { intent: 'security-review', taskType: 'security', agent: 'security-auditor', complexity: 7, prompt: 'check this query for sql injection risks' },
  { intent: 'security-review', taskType: 'security', agent: 'security-auditor', complexity: 8, prompt: 'penetration test the password reset flow' },
  { intent: 'security-review', taskType: 'security', agent: 'security-auditor', complexity: 6, prompt: 'verify the input validation on the user-facing endpoints' },
  { intent: 'security-review', taskType: 'security', agent: 'security-auditor', complexity: 7, prompt: 'look for xss and csrf issues in the templating layer' },

  // write-docs / doc-writer
  { intent: 'write-docs', taskType: 'docs', agent: 'doc-writer', complexity: 2, prompt: 'add jsdoc comments to the public api' },
  { intent: 'write-docs', taskType: 'docs', agent: 'doc-writer', complexity: 3, prompt: 'write a readme for this package' },
  { intent: 'write-docs', taskType: 'docs', agent: 'doc-writer', complexity: 2, prompt: 'add docstrings to the exported functions' },
  { intent: 'write-docs', taskType: 'docs', agent: 'doc-writer', complexity: 4, prompt: 'document the rest api endpoints in markdown' },
  { intent: 'write-docs', taskType: 'docs', agent: 'doc-writer', complexity: 3, prompt: 'explain how this module works for new contributors' },
  { intent: 'write-docs', taskType: 'docs', agent: 'doc-writer', complexity: 4, prompt: 'write a migration guide from v1 to v2' },

  // code-review / code-reviewer
  { intent: 'code-review', taskType: 'code', agent: 'code-reviewer', complexity: 5, prompt: 'review this pull request and flag anything concerning' },
  { intent: 'code-review', taskType: 'code', agent: 'code-reviewer', complexity: 5, prompt: 'review my changes to the payment processor' },
  { intent: 'code-review', taskType: 'code', agent: 'code-reviewer', complexity: 6, prompt: 'check this code for correctness, style, and maintainability' },
  { intent: 'code-review', taskType: 'code', agent: 'code-reviewer', complexity: 5, prompt: 'give me a second opinion on this refactor' },

  // refactor
  { intent: 'refactor', taskType: 'refactor', agent: 'code-reviewer', complexity: 5, prompt: 'refactor the auth middleware to be more testable' },
  { intent: 'refactor', taskType: 'refactor', agent: 'code-reviewer', complexity: 6, prompt: 'restructure this module to separate concerns' },
  { intent: 'refactor', taskType: 'refactor', agent: 'code-reviewer', complexity: 4, prompt: 'simplify the nested conditionals in this function' },
  { intent: 'refactor', taskType: 'refactor', agent: 'code-reviewer', complexity: 7, prompt: 'reorganize the codebase to reduce coupling between layers' },
  { intent: 'refactor', taskType: 'refactor', agent: 'code-reviewer', complexity: 4, prompt: 'extract this duplicated logic into a shared helper' },

  // architecture
  { intent: 'architecture', taskType: 'architecture', agent: 'architect', complexity: 7, prompt: 'design the data model for a multi-tenant saas' },
  { intent: 'architecture', taskType: 'architecture', agent: 'architect', complexity: 8, prompt: 'architect a system to handle 10x the current traffic' },
  { intent: 'architecture', taskType: 'architecture', agent: 'architect', complexity: 7, prompt: 'propose a schema for the new analytics events table' },
  { intent: 'architecture', taskType: 'architecture', agent: 'architect', complexity: 8, prompt: 'design pattern recommendation for this plugin system' },
  { intent: 'architecture', taskType: 'architecture', agent: 'architect', complexity: 7, prompt: 'lay out the service boundaries for this domain' },

  // research / researcher
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 6, prompt: 'research the best embedding model for our use case' },
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 6, prompt: 'compare postgres and clickhouse for our analytics workload' },
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 7, prompt: 'evaluate which message queue fits our throughput target' },
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 6, prompt: 'survey the current state of webgpu inference libraries' },
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 7, prompt: 'benchmark these three options under realistic load' },
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 6, prompt: 'compare two databases for our analytics workload' },
  { intent: 'research', taskType: 'research', agent: 'researcher', complexity: 6, prompt: 'what are the tradeoffs between these libraries' },

  // performance / performance-reviewer
  { intent: 'performance', taskType: 'code', agent: 'performance-reviewer', complexity: 6, prompt: 'optimize the slow query on the orders dashboard' },
  { intent: 'performance', taskType: 'code', agent: 'performance-reviewer', complexity: 7, prompt: 'profile the request handler and find the bottleneck' },
  { intent: 'performance', taskType: 'code', agent: 'performance-reviewer', complexity: 7, prompt: 'reduce p99 latency on the search endpoint' },
  { intent: 'performance', taskType: 'code', agent: 'performance-reviewer', complexity: 6, prompt: 'investigate the memory leak in the worker process' },

  // bash-script / script-writer
  { intent: 'bash-script', taskType: 'script', agent: 'script-writer', complexity: 3, prompt: 'write a bash script to rotate logs nightly' },
  { intent: 'bash-script', taskType: 'script', agent: 'script-writer', complexity: 3, prompt: 'shell script that backs up the database to s3' },
  { intent: 'bash-script', taskType: 'script', agent: 'script-writer', complexity: 3, prompt: 'automation script to deploy the staging environment' },
  { intent: 'bash-script', taskType: 'script', agent: 'script-writer', complexity: 2, prompt: 'cron job to clean up tmp files older than a week' },

  // api-design / api-reviewer
  { intent: 'api-design', taskType: 'architecture', agent: 'api-reviewer', complexity: 7, prompt: 'design the rest api for the new billing module' },
  { intent: 'api-design', taskType: 'architecture', agent: 'api-reviewer', complexity: 7, prompt: 'graphql schema for the user activity feed' },
  { intent: 'api-design', taskType: 'architecture', agent: 'api-reviewer', complexity: 6, prompt: 'design the contract between the frontend and the new microservice' },
  { intent: 'api-design', taskType: 'architecture', agent: 'api-reviewer', complexity: 7, prompt: 'what should the public api surface look like for this library' },

  // implement-feature
  { intent: 'implement-feature', taskType: 'code', agent: 'code-reviewer', complexity: 5, prompt: 'implement the password reset flow' },
  { intent: 'implement-feature', taskType: 'code', agent: 'code-reviewer', complexity: 6, prompt: 'build the saved-filters feature for the search page' },
  { intent: 'implement-feature', taskType: 'code', agent: 'code-reviewer', complexity: 6, prompt: 'add a webhook endpoint that fans out to subscribers' },
  { intent: 'implement-feature', taskType: 'code', agent: 'code-reviewer', complexity: 5, prompt: 'create the new admin panel for managing api keys' },
  { intent: 'implement-feature', taskType: 'code', agent: 'code-reviewer', complexity: 4, prompt: 'add a dark mode toggle to the settings page' },
];

// Sanity stats — useful at startup for logging.
export function exemplarStats() {
  const byIntent = {};
  for (const e of EXEMPLARS) byIntent[e.intent] = (byIntent[e.intent] || 0) + 1;
  return { total: EXEMPLARS.length, byIntent };
}
