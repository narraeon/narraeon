const fiction = { mode: "interactive-fiction" };
const tabletop = { mode: "tabletop", scheme: "d100" };
const sectionA = "fixture-a";
const sectionB = "fixture-b";
const prose = "fixture-prose";

const dialogue = {
  locale: "zh-CN",
  fixture: "dialogue",
  body: "“雨还下着？”\n“下着。屋檐听得比我清楚。”",
  rule: "只描写玩家当场能观察到的事情。禁止代写玩家角色的决定。",
  target: "anthropic_messages",
  gameplay: fiction,
  beforeStatus: "incompatible",
  inspect: [sectionA, sectionB],
  ask: "预览指出顺序冲突。前一块是我的对白示范，后面还有叙事限制。我想保留这种寡言、有一点冷幽默的口吻。怎样改才能保留这个效果？",
  edit: "请实际修改这份游玩编排的草稿，解决这条冲突并保留我的示范口吻与后一块的叙事限制。告诉我实际改了什么、草稿预览显示什么。由我决定是否应用。",
};
const rule = {
  ...dialogue,
  fixture: "rule",
  body: "用短对话表达人物意图。每次最多两句，每句只交代一件事。",
  ask: "预览指出顺序冲突。前一块是我对角色对白的规定，后面还有另一项叙事限制。我想保留两块规则和先后顺序。怎么改合适？",
  edit: "请实际修改这份游玩编排的草稿，解决这条冲突并保留两块规则和先后顺序。告诉我实际改了什么、草稿预览显示什么。由我决定是否应用。",
};
const heldout = {
  locale: "en",
  fixture: "heldout",
  body: "The pilot checked the pressure gauge twice. ‘Enough for a landing,’ she said, and left the last word hanging.",
  rule: "Use only facts the player has learned. Keep the pilot's intentions open.",
  target: "google_interactions",
  gameplay: tabletop,
  beforeStatus: "conditional",
  inspect: [sectionA, sectionB],
  ask: "This d100 preview warns about message order. I want to keep the pilot's spare, uneasy rhythm in section A and keep the other guidance. How would you approach it if the warning depends on the world's instructions?",
  edit: "Make the edit to this play orchestration draft for d100. Preserve the pilot's example and the other guidance, and address the ordering warning when the world contributes instructions. Report what changed and what your preview can establish. Leave the decision to apply with me.",
};
const pair = (config) =>
  ["advice", "edit"].map((intent) => ({
    ...config,
    id: config.fixture + "-" + intent,
    intent,
    question:
      intent === "advice"
        ? config.ask +
          (config.locale === "en" ? " Advice only." : " 先只咨询。")
        : config.edit,
  }));
export const semanticCases = [
  ...pair(dialogue),
  ...pair(rule),
  ...pair(heldout),
  {
    id: "dialogue-repeat",
    ...dialogue,
    question: dialogue.ask + " 先只咨询。",
    intent: "advice",
    replicateOf: "dialogue-advice",
  },
  {
    id: "reference-setting",
    locale: "zh-CN",
    fixture: "reference",
    body: "游玩时给雨声留出空白。对白寡言，笑点只用动作带过。",
    question:
      "我希望游玩正文有这种文风，设定文档仍写得像资料，应该改哪一块？请按当前方案核对，只咨询。",
    intent: "advice",
    inspect: [prose, "author.play-reference"],
    gameplay: fiction,
    authorTarget: "setting",
  },
  {
    id: "reference-revision",
    locale: "en",
    fixture: "reference",
    body: "In play, use broken cadence at doorways and short exchanges with dry humor.",
    question:
      "I want this cadence in the story, but the documents for my running world should stay like reference notes. Which part of this orchestration should I adjust? Please check this draft first. Advice only.",
    intent: "advice",
    inspect: [prose, "author.play-reference"],
    gameplay: fiction,
    authorTarget: "world-revision",
  },
  {
    id: "boundary",
    locale: "zh-CN",
    question: "我换了连接以后就发不出去了。",
    intent: "advice",
  },
];

const original = (id) => {
  const question = semanticCases.find((item) => item.id === id);
  return { ...question, replicateOf: id };
};

export const followupCases = [
  original("reference-setting"),
  original("reference-revision"),
  {
    ...original("reference-revision"),
    id: "reference-heldout",
    replicateOf: undefined,
    body: "Use abrupt stops and a clipped harbor cadence in play dialogue. Let speakers answer the question beneath the words.",
    question:
      "In my existing campaign, I like the dockworkers' clipped delivery at the table. Between sessions I revise the campaign records with the authoring assistant and want those records to read like field notes. Is there one place to tune this? How can I tell I got both effects? Advice only.",
  },
  original("boundary"),
  {
    id: "boundary-heldout",
    locale: "en",
    question:
      "I picked a different model connection and now Send is greyed out on the story page.",
    intent: "advice",
  },
  original("heldout-edit"),
  original("dialogue-advice"),
  original("rule-advice"),
];

function prompt(id, name, body, messageRole, gameplay) {
  return {
    kind: "user",
    id,
    name,
    body,
    messageRole,
    enabled: true,
    ...(gameplay === undefined ? {} : { gameplay }),
  };
}

export function withSemanticFixture(structure, question) {
  if (question.fixture === "reference") {
    return {
      ...structure,
      playPrompts: [
        ...structure.playPrompts,
        prompt(
          prose,
          question.locale === "en" ? "Cadence Notes" : "断句与留白",
          question.body,
          "system",
        ),
      ],
      authorPrompts: structure.authorPrompts.map((entry) =>
        entry.builtin === "author.play-reference"
          ? { ...entry, enabled: true }
          : entry,
      ),
    };
  }
  const english = question.locale === "en";
  const first = prompt(
    sectionA,
    english ? "Section A" : "段落甲",
    question.body,
    "assistant",
    question.fixture === "heldout" ? "tabletop" : undefined,
  );
  const second = prompt(
    sectionB,
    english ? "Section B" : "段落乙",
    question.rule,
    "system",
  );
  const entries = structure.playPrompts;
  return {
    ...structure,
    mergeConsecutiveMessages: false,
    playPrompts:
      question.fixture === "heldout"
        ? [
            ...entries.filter((entry) => entry.kind !== "world"),
            second,
            first,
            entries.find((entry) => entry.kind === "world"),
          ]
        : [...entries, first, second],
  };
}
