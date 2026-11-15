// Gate routes of the skill router: workflow prompts that are not UI specific, each with the line the hook injects.
// Exports: GATE_ROUTES, an array of { skill?, everyTime?, test: RegExp, line: string } in injection order.
// Invariants: pure data, no I/O. A route with a `skill` is named once per session (and again after a compact) by the
// caller; a route with `everyTime` (the repeated report, which names no skill) shows on every match. Harness events are
// filtered by the caller, not here.
// Gate routes: workflow skills that are not UI specific, named once per session (and again after a compact); the
// repeated-report route names no skill and fires on every match (`everyTime`). Triggers
// are intents, not words: an imperative "fix ..." / a bug, crash or failing test; a "done?", "ship it", "ready to
// merge" request; a repository-level restructure ("remove Nx", "merge the apps into one project"); git history or
// branch work ("clean up the git tree", "rebase", "delete the merged branches", "merge everything to master"). "fixed",
// "prefix", "when you are done", "merge conflicts", "restructure this function", "branch coverage" and "merge sort" do not fire.
const SENTENCE_START = String.raw`(?:^|[.!?:]\s+|\b(?:please|pls|can you|could you|would you|need to|needs to|let'?s|and|then|go)\s+)`;
// Build tools and layers whose removal restructures a whole repository. "nx-cache", "module federation remote" and
// "remove nx from .gitignore" are single-file talk, so the name must not continue that way.
const REMOVABLE_LAYER = String.raw`(?:the\s+)?(?:nx|turborepo|lerna|module federation|monorepo tool)(?![\w-]|\s+(?:cache|remotes?)\b|\s+(?:from|in)\s+(?:the\s+)?\.?(?:gitignore|package\.json|tsconfig|eslint|readme))`;
const REPO_NOUN = String.raw`(?:repo(?:sitory)?|project|monorepo|codebase|workspace)`;
// Branch names a merge lands on. "main.ts" is a file, so the name must not continue as a path or word.
const BASE_BRANCH = String.raw`(?:master|main|trunk|develop|the\s+base(?:\s+branch)?|the\s+default\s+branch)(?![\w-]|\.\w)`;
export const GATE_ROUTES = [
  {
    skill: 'root-cause-debug',
    test: new RegExp(
      `${SENTENCE_START}(?:fix|debug|diagnose|troubleshoot)\\b` +
        String.raw`|\b(?:bugs?|crash(?:es|ed|ing)?|regressions?|flaky|stack ?traces?)\b` +
        String.raw`|\b(?:is|are|was|were|keeps?|still|now|got)\s+(?:broken|failing|crashing)\b` +
        String.raw`|\b(?:failing|broken)\s+(?:tests?|build|ci|pipeline)\b|\b(?:tests?|build|ci|pipeline)\s+(?:is |are )?(?:failing|red|broken)\b` +
        String.raw`|\b(?:does(?:n'?t| not)|do(?:n'?t| not)|won'?t|isn'?t|not)\s+work(?:ing)?\b` +
        String.raw`|باگ|رفع (?:باگ|خطا|مشکل)|کار نمی`,
      'i',
    ),
    line: 'Skill router: bug or failure - invoke root-cause-debug (skip if already loaded) before proposing a fix; tdd-loop for the fix itself.',
  },
  {
    skill: 'verify-done',
    test: new RegExp(
      String.raw`\b(?:(?:is|was) (?:it|this|that) (?:done|finished|ready)|(?:are we|we'?re|we are|i'?m|i am|it'?s|it is|all) (?:all )?(?:done|finished)` +
        String.raw`|ready (?:to|for) (?:ship|merge|release|review|deploy)|(?:ship|merge|release) (?:it|this|that|the (?:pr|branch|change|changes|work))` +
        String.raw`|(?:can|should|could) (?:we|i) (?:ship|merge|release)|wrap(?:ping)? (?:it )?up|mark (?:it )?(?:as )?done)\b` +
        String.raw`|تمام شد|merge کن|آماده merge`,
      'i',
    ),
    line: 'Skill router: done or ship - invoke verify-done (skip if already loaded) before claiming done, fixed or ready.',
  },
  {
    skill: 'repo-restructure',
    test: new RegExp(
      String.raw`\brestructur\w*\s+(?:the\s+|our\s+|this\s+|my\s+)?(?:whole\s+|entire\s+)?${REPO_NOUN}\b` +
        String.raw`|\b(?:remove|drop|delete|get rid of|eliminate|replace|migrate (?:off|away from)|move (?:off|away from))\s+${REMOVABLE_LAYER}` +
        String.raw`|\b(?:nx|turborepo|lerna|module federation)\s+(?:is |are )?(?:no longer|not) (?:needed|used|required)\b` +
        String.raw`|\bmerge\s+(?:(?:all|the|our)\s+)*(?:everything|apps?|packages?|libs?|libraries|projects|repos|workspaces)\b[^.!?]{0,30}\binto\s+(?:an?|one|1|single|the)\b` +
        String.raw`|\bconvert\s+(?:the\s+|our\s+|this\s+)?monorepo\b` +
        String.raw`|\bclean[\s-]?up\s+(?:the\s+|our\s+)?(?:(?:root|top[\s-]level)\s+(?:folder\s+)?of\s+(?:the\s+|our\s+)?)?${REPO_NOUN}\b` +
        String.raw`|(?:تغییر|بازسازی|بازآرایی)\s*ساختار\s*(?:پروژه|ریپو|مخزن|مونوریپو)`,
      'i',
    ),
    line: 'Skill router: repository restructure - invoke repo-restructure (skip if already loaded) before moving or deleting anything.',
  },
  {
    skill: 'git-linear-history',
    test: new RegExp(
      String.raw`\bgit\s+(?:tree|history|graph)\b` +
        String.raw`|\brebas(?:e|ing)\b` +
        String.raw`|\b(?:remove|delete|prune|drop|clean(?:[\s-]?up)?|get rid of)\s+(?:(?:the|all|old|stale|merged|leftover|local|remote|git)\s+)*(?:branches|worktrees)\b` +
        String.raw`|\bmerged\s+(?:branch|worktree)\b` +
        String.raw`|\bmerge\s+(?:(?:all|the|our|every|this|that|my)\s+)*(?:everything|branch(?:es)?|lanes?|worktrees?)\b[^.!?]{0,30}\b(?:to|into|onto)\s+${BASE_BRANCH}` +
        String.raw`|\bland\s+(?:(?:the|all|our|these|my)\s+)*(?:lanes?|branch(?:es)?|worktrees?)\b` +
        String.raw`|\bsquash\w*\s+(?:(?:the|these|those|my|all|our)\s+)*(?:commits?|history)\b` +
        String.raw`|تاریخچه[\s‌]*گیت|درخت[\s‌]*گیت|برنچ`,
      'i',
    ),
    line: 'Skill router: git history or branches - invoke git-linear-history (skip if already loaded) before merging, rebasing or deleting branches.',
  },
  {
    // The owner reports the same defect again or repeats an instruction. No skill to name, so no once-per-session
    // marker: the line shows on every match (`everyTime`), because each repeat is a new failure of the last fix.
    // "still", "again" and "same" alone are common words ("is it still running", "run it again"), so each pattern needs
    // its partner: still + a symptom word, "not fixed", "same <defect> again", "i told you", "<ordinal> time".
    everyTime: true,
    test: new RegExp(
      String.raw`\bstill\s+(?:wrong|broken|failing|incorrect|flash\w*|flicker\w*|blink\w*|not\s+(?:fixed|working|right|correct|resolved|solved|showing|visible))\b` +
        String.raw`|\bnot\s+(?:yet\s+)?(?:fixed|resolved|solved)\b` +
        String.raw`|\b(?:same|similar)\s+(?:problem|issue|bug|error|defect)s?\s+again\b|\bagain\s+(?:the\s+)?same\s+(?:problem|issue|bug|error|defect)` +
        String.raw`|\bi\s+(?:already\s+)?(?:told|said|mentioned)\s+(?:you\b|(?:this|that|it)\s+before\b|before\b)` +
        String.raw`|\bas\s+(?:i|we)\s+(?:said|talked|told|discussed|mentioned|agreed)\b` +
        String.raw`|\bthe\s+(?:second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+time\b` +
        String.raw`|هنوز\s*(?:هم\s*)?(?:درست|حل|رفع)?\s*(?:نشده|نشد|خراب|اشتباه)` +
        String.raw`|دوباره\s+(?:همان|همون|همین)\s+(?:مشکل|باگ|خطا)`,
      'i',
    ),
    line: 'Skill router: repeated report - the last fix did not hold: reproduce the exact symptom first, change approach (C22), and check that symptom itself before replying.',
  },
];
