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
const REPO_NOUN = String.raw`(?:repo(?:sitory)?|project|monorepo|codebase|workspace)`;
// What may follow a repository noun or a build-tool name for the sentence to be about the whole repository: the end of
// the clause, or a word that closes it. A following noun means code or a file ("project settings dialog", "nx.json",
// "the nx logo", "repository pattern"), so it is not listed.
const CLOSING_WORDS = 'and|to|into|so|completely|entirely|altogether|now|please|again|with|for|before|after|because|since|as';
// The clause ends here: end of text or punctuation. A dot counts only before a space or the end, so "lerna.json" is a file.
const STOP = String.raw`\s*(?:$|[,;:!?)]|\.(?:\s|$))`;
const CLAUSE_END = String.raw`(?=${STOP}|\s+(?:${CLOSING_WORDS})\b)`;
const REPO_END = String.raw`(?=${STOP}|\s+(?:folders?|structure|layout|files|tree|from|${CLOSING_WORDS})\b)`;
// Build tools and layers whose removal restructures a whole repository ("remove nx from our project completely").
const REMOVABLE_LAYER = String.raw`(?:the\s+)?(?:nx|turborepo|lerna|module federation|monorepo tool)(?:${CLAUSE_END}|\s+from\s+(?:the\s+|our\s+|this\s+|my\s+)?${REPO_NOUN}\b)`;
// Where a merge of several apps ends up: one repository-level thing, never an array, a map or a lockfile.
const MERGE_TARGET = String.raw`(?:an?\s+|one\s+|1\s+|the\s+)?(?:(?:single|simple|new|one|1)\s+)?(?:project|app|application|repo(?:sitory)?|package|workspace|monorepo)\b`;
// Branch names a merge lands on. "main.ts" is a file, so the name must not continue as a path or word.
const BASE_BRANCH = String.raw`(?:master|main|trunk|develop|the\s+base(?:\s+branch)?|the\s+default\s+branch)(?![\w-]|\.\w)`;
// "rebase" as an action: on a target ("rebase my branch", "rebase onto develop", "git rebase origin/main") or as the
// command itself ("please rebase"). "what does rebase do" and "explain rebase vs merge" are questions, not work.
const REBASE_ACTION = String.raw`\brebas(?:e|ing)\s+(?:(?:my|the|our|this|that|these|those|your|it|them|all)\b|(?:on|onto|against)\s|-\w|(?:origin\/)?${BASE_BRANCH})` +
  String.raw`|${SENTENCE_START}rebase\b(?!\s+(?:vs|versus|do|does|work|works|mean|means|is|are)\b)`;
// Persian "branch" (برنچ) only with a clean-up or merge word (پاک, حذف, ادغام, مرج); "create a branch" is not git history work.
const PERSIAN_BRANCH_CLEANUP = String.raw`(?:پاک|حذف|ادغام|مرج)\S*\s+(?:\S+\s+){0,2}?برنچ|برنچ\S*\s+(?:\S+\s+){0,2}?(?:پاک|حذف|ادغام|مرج)`;
// "branches of the decision tree", "remove branches from the AST": branches of a data structure, not of a repository.
const NOT_CODE_STRUCTURE = String.raw`(?!\s+(?:of|from|in)\s+(?:the\s+|an?\s+)?(?:\w+\s+)?(?:tree|ast|graph|diagram|animation|dom|json|parser|compiler|state machine)\b)`;
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
      String.raw`\brestructur\w*\s+(?:the\s+|our\s+|this\s+|my\s+)?(?:whole\s+|entire\s+)?${REPO_NOUN}\b${REPO_END}` +
        String.raw`|\b(?:remove|drop|delete|get rid of|eliminate|replace|migrate (?:off|away from)|move (?:off|away from))\s+${REMOVABLE_LAYER}` +
        String.raw`|\b(?:nx|turborepo|lerna|module federation)\s+(?:is |are )?(?:no longer|not) (?:needed|used|required)\b` +
        String.raw`|\bmerge\s+(?:(?:all|the|our)\s+)*(?:everything|apps?|packages?|libs?|libraries|projects|repos|workspaces)\b[^.!?]{0,30}\binto\s+${MERGE_TARGET}` +
        String.raw`|\bconvert\s+(?:the\s+|our\s+|this\s+)?monorepo\b` +
        String.raw`|\bclean[\s-]?up\s+(?:the\s+|our\s+)?(?:(?:root|top[\s-]level)\s+(?:folder\s+)?of\s+(?:the\s+|our\s+)?)?${REPO_NOUN}\b${REPO_END}` +
        String.raw`|(?:تغییر|بازسازی|بازآرایی)\s*ساختار\s*(?:پروژه|ریپو|مخزن|مونوریپو)`,
      'i',
    ),
    line: 'Skill router: repository restructure - invoke repo-restructure (skip if already loaded) before moving or deleting anything.',
  },
  {
    skill: 'git-linear-history',
    test: new RegExp(
      String.raw`\bgit\s+(?:tree|history)\b|\b(?:clean(?:[\s-]?up)?|tidy|fix|straighten|linearize|flatten)\s+(?:up\s+)?(?:the\s+)?git\s+graph\b` +
        String.raw`|${REBASE_ACTION}` +
        String.raw`|\bmerge\s+${BASE_BRANCH}\s+into\s+(?:my|the|this|our|your)\s+(?:\w+\s+)?(?:branch|lane|worktree)\b` +
        String.raw`|\b(?:remove|delete|prune|drop|clean(?:[\s-]?up)?|get rid of)\s+(?:(?:the|all|old|stale|merged|leftover|local|remote|git)\s+)*(?:branches|worktrees)\b${NOT_CODE_STRUCTURE}` +
        String.raw`|\bmerged\s+(?:branch|worktree)\b` +
        String.raw`|\bmerge\s+(?:(?:all|the|our|every|this|that|my)\s+)*(?:everything|branch(?:es)?|lanes?|worktrees?)\b[^.!?]{0,30}\b(?:to|into|onto)\s+${BASE_BRANCH}` +
        String.raw`|\bland\s+(?:(?:the|all|our|these|my)\s+)*(?:lanes?|branch(?:es)?|worktrees?)\b${NOT_CODE_STRUCTURE}` +
        String.raw`|\bsquash\w*\s+(?:(?:the|these|those|my|all|our)\s+)*(?:commits?|history)\b` +
        String.raw`|تاریخچه[\s‌]*گیت|درخت[\s‌]*گیت|${PERSIAN_BRANCH_CLEANUP}`,
      'i',
    ),
    line: 'Skill router: git history or branches - invoke git-linear-history (skip if already loaded) before merging, rebasing or deleting branches.',
  },
  {
    // The owner reports the same defect again or repeats an instruction. No skill to name, so no once-per-session
    // marker: the line shows on every match (`everyTime`), because each repeat is a new failure of the last fix.
    // "still", "again" and "same" alone are common words ("is it still running", "run it again"), so each pattern needs
    // its partner: still + a symptom word, "not fixed", "back again", "you did not fix", "same <defect> again", "i told you",
    // "as i said before", "this is the <ordinal> time".
    everyTime: true,
    test: new RegExp(
      String.raw`\bstill\s+(?:wrong|broken|failing|incorrect|flash\w*|flicker\w*|blink\w*|not\s+(?:fixed|working|right|correct|resolved|solved|showing|visible)|(?:does(?:n'?t| not)|do(?:n'?t| not)|won'?t|can'?t|isn'?t|aren'?t))\b` +
        String.raw`|\bnot\s+(?:yet\s+)?fixed\b|\b(?:is|are|it'?s|they'?re)\s+back\s+again\b` +
        String.raw`|\byou\s+(?:didn'?t|did\s+not|haven'?t|have\s+not|never)\s+(?:fix|fixed|solve|solved|resolve|resolved)\b` +
        String.raw`|\b(?:same|similar)\s+(?:problem|issue|bug|error|defect)s?\s+again\b|\bagain\s+(?:the\s+)?same\s+(?:problem|issue|bug|error|defect)` +
        String.raw`|\bi\s+(?:already\s+)?asked\s+you\b[^.!?]{0,40}\b(?:twice|three times|several times|already|before)\b` +
        String.raw`|\bi\s+(?:already\s+)?(?:told|said|mentioned)\s+(?:you\b|(?:this|that|it)\s+before\b|before\b)` +
        String.raw`|\bas\s+(?:i|we)\s+(?:said|talked|told|discussed|mentioned|agreed)\s+(?:before|earlier|already|previously|you)\b` +
        String.raw`|\bthis\s+is\s+the\s+(?:second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+time\b` +
        String.raw`|\bfor\s+the\s+(?:second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+time(?=${STOP})` +
        String.raw`|هنوز\s*(?:هم\s*)?(?:(?:درست|حل|رفع)\s*نشده|خراب|اشتباه)` +
        String.raw`|دوباره\s+(?:همان|همون|همین)\s+(?:مشکل|باگ|خطا)`,
      'i',
    ),
    line: 'Skill router: repeated report - the last fix did not hold: reproduce the exact symptom first, change approach (C22), and check that symptom itself before replying.',
  },
];
