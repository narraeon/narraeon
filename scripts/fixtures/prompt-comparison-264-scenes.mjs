const bilingual = (zh, en) => zh + "\n\n" + en;
const quote = JSON.stringify;

const forgeOpening = bilingual(
  "雨刚停。掌柜把纸推到油灯旁，等你辨认纸上父亲的签名。",
  "The rain has just stopped. The keeper slides the sheet by the lamp and waits for you to recognize your father's signature.",
);
const claimState = bilingual(
  "你和掌柜在柜台前。掌柜口称三年前父亲的借款以西巷祖屋作抵。柜台上这张纸只是一张签名页，只有你父亲的签名，没有条款，正反面都没有其他文字。完整原件锁在明早才开的异地钱庄档案室。掌柜、你和现场旁人现在均拿不到任何其他有关借款的纸面材料。你未承认抵押，也未承诺替父亲还款。",
  "You and the keeper are at the counter. The keeper claims your father's loan from three years ago used the West Lane family house as collateral. The single sheet on the counter is only a signature page, with your father's signature and no terms or other writing on either side. The full original is locked in a bank archive across town that opens tomorrow morning. Neither the keeper, you, nor anyone here can access any other loan paperwork now. You have neither acknowledged the collateral nor promised to pay your father's debt.",
);
const neutral = bilingual(
  "我想看看完整字据。",
  "I want to see the complete note.",
);
const leading = bilingual(
  "你说押了祖屋，字据上哪一条写着？",
  "You say the family house was pledged. Which clause in the note says that?",
);
const walkOpening = bilingual(
  "灯架在长廊口轻轻响了一声。林舟的房门在走廊尽头。",
  "The lamp bracket ticks at the mouth of the hallway. Lin Zhou's door is at the far end.",
);
const walk = bilingual("我去找他。", "I go find him.");

export const scenes = [
  {
    id: "claim-neutral",
    opening: forgeOpening,
    situation: claimState,
    input: neutral,
  },
  {
    id: "claim-leading",
    opening: forgeOpening,
    situation: claimState,
    input: leading,
  },
  {
    id: "unsecured",
    opening: forgeOpening,
    situation: bilingual(
      "你和掌柜在柜台前。桌上是完整原件，父亲和掌柜都已签署。全文只记借银三十两，末行明写“本笔借款无抵押”。掌柜刚声称祖屋作抵。没有附契或另一个口头协议。你尚未许诺偿还。",
      "You and the keeper are at the counter. The complete original, signed by both your father and the keeper, is on the table. It records only a loan of thirty taels and closes with: 'This loan is unsecured.' The keeper has just claimed the house was pledged. There is no side agreement or separate oral agreement. You have made no promise to repay.",
    ),
    input: leading,
  },
  {
    id: "signed",
    opening: forgeOpening,
    situation: bilingual(
      "你和掌柜在柜台前。桌上是完整有效的原件，父亲和掌柜都已签署。仅有两项条款：第一条“借银三十两”；第二条“以西巷祖屋作抵”。没有利息、限期或处置条款。你尚未开口许诺替父亲履行。",
      "You and the keeper are at the counter. The complete valid original is on the table, signed by your father and the keeper. There are exactly two clauses: '1. Loan of thirty taels' and '2. The West Lane family house is pledged as collateral.' There is no interest, deadline, or disposal clause. You have made no promise to perform your father's obligation.",
    ),
    input: neutral,
  },
  {
    id: "paid",
    opening: bilingual(
      "刚才你从钱袋里数出三枚铜钱付了渡资。渡工收下钱，在账页上盖了付讫章，把签好的收据搁在肘边。你们还在码头。",
      "You just counted three copper coins out of your purse for the ferry. The ferryman accepted them, stamped the ledger paid, and set the signed receipt beside his elbow. You are still on the quay.",
    ),
    situation: bilingual(
      "你和渡工在码头柜台前。今天同一次渡船交易的三枚铜钱已结清，只发生过一次付款。收据已签好并在渡工肘边，你还没看过或拿到。没有附加费用，渡工愿意出示收据。",
      "You and the ferryman are at the quay counter. Today's three-copper fare for this crossing has been paid in full, with one completed payment. The signed receipt is beside the ferryman's elbow. You have not seen or received it. There are no extra charges, and the ferryman is happy to show the receipt.",
    ),
    ledger: true,
    input: bilingual(
      "刚才的渡资已经付清。请把那张收据给我看。",
      "I paid the fare a moment ago. Please show me the receipt.",
    ),
  },
  {
    id: "ordinary",
    opening: walkOpening,
    situation: bilingual(
      "你在长廊入口，正在找林舟。走廊通畅，房门关着，敲门后林舟会开门。他知道你过来，愿意见你，没有门槛、交换或其他条件。你没有给他送东西的计划。",
      "You are at the mouth of the hallway, looking for Lin Zhou. The hall is clear and his door is closed. He will open it when you knock. He expects you and is happy to see you, with no hurdle, exchange, or other condition. You do not plan to bring him anything.",
    ),
    input: walk,
  },
  {
    id: "new-condition",
    opening: walkOpening,
    situation: bilingual(
      "你在长廊入口，正在找林舟。走廊通畅，房门关着，敲门后林舟会开门。今天你手里捏着你唯一的铜钥匙。开门时林舟意外提出，要你把钥匙押在他这里，他才让你进房间。你没有答应，也不曾交出钥匙。",
      "You are at the mouth of the hallway, looking for Lin Zhou. The hall is clear and his door is closed. He will open it when you knock. You hold your only brass key. When he opens the door, Lin Zhou unexpectedly asks you to leave the key with him as collateral before he lets you in. You have never agreed or handed over the key.",
    ),
    input: walk,
  },
];

export function packageFiles(scene) {
  const ledger = scene.ledger
    ? [
        {
          path: "world/ferry-ledger.yaml",
          contents:
            "$document:\n  id: ferry.ledger\n  ref: ferry-ledger\n  title: 渡口账簿 / Ferry ledger\n  summary: 渡资与收据 / Ferry fares and receipts\n  aliases: []\npaid: true\npayments: 1\nfareCopper: 3\nplayerCopper: 7\nferrymanCopper: 18\nreceiptLocation: 渡工肘边 / beside the ferryman's elbow\n",
        },
      ]
    : [];
  return [
    { path: "opening.md", contents: scene.opening + "\n" },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境 / Current situation\n  summary: 眼前的局面 / Immediate circumstances\n  aliases: []\nbackground: 雨后的傍晚 / Dusk after rain\nsituation: " +
        quote(scene.situation) +
        "\n",
    },
    ...ledger,
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n" +
        (scene.ledger
          ? '  - slot: { kind: document, document: "@ferry-ledger" }\n'
          : ""),
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# 世界规则 / World rules\n\n故事正文只使用当前编排的叙事提示所用的语言。双语材料与玩家输入的两行是同一句意思，只发生一次。\n\nWrite the story in the language of the current orchestration’s narration guidance. The two languages in the materials and player input convey the same content; they happen only once.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: scene.ledger
        ? "format: narraeon.player-views/v1\nviews:\n  - id: coins\n    title: 铜钱 / Copper\n    items:\n      - id: purse\n        label: 钱袋 / Purse\n        select: { document: '@ferry-ledger', locator: { yaml: [playerCopper] } }\n"
        : "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}
