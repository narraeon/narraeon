import { stringify } from "yaml";

export const scenes = [
  {
    id: "conversation-zh",
    locale: "zh-CN",
    topic: "conversation",
    title: "收摊后的茶桌",
    opening:
      "茶摊已经收摊。檐下拴着的风铃很轻地响，桌上还有没收走的三只杯子。你和修伞匠宁、送货员禾坐在桌边。禾的手搭在一捆尚待送出的包裹上。",
    fixed: [
      "今夜没人要求你帮忙、安排会面或作出承诺。你没有和宁或禾约定再见。",
      "宁想念搬走的姐姐。她愿意说想念是什么样，但不愿今晚去找姐姐，也不愿收下旁人替她安排的探访。",
      "禾得在交班铃前送出余件，能再坐几句话。禾不认识宁的姐姐，也没法代宁联络她。",
    ],
    voices: [
      "宁说话留半拍，常用修伞的具体手艺解释自己，避免直说情绪。",
      "禾讲话短，喜欢把抽象话拉回一件眼前能做的事，说急了会省略主语。",
    ],
    turns: [
      "我坐在原处，问宁：“今天收摊的时候，有没有一刻特别想你姐姐？”",
      "我还坐着，问她们俩：“要形容想念，哪件寻常东西最像？你们可以说不一样的。”",
      "我对宁说：“我只是想听你说。今晚你想就这样坐一会儿吗？”我没有作任何安排。",
      "我在原处再坐一小会儿，听她们说完。不作约定，也不用替我补告别的话。",
    ],
  },
  {
    id: "conversation-en",
    locale: "en",
    topic: "conversation",
    title: "The table after closing",
    opening:
      "The tea stall is closed. A bell tied beneath the awning rings softly, and three uncollected cups sit on the table. You sit with Ning, who mends umbrellas, and He, a courier. He rests a hand on a bundle she still has to deliver.",
    fixed: [
      "Nobody has asked you to help, arrange a meeting, or make a promise tonight. You have no plans to meet Ning or He again.",
      "Ning misses her sister who moved away. She is willing to talk about what missing her feels like, but does not want to visit her tonight or accept a visit arranged on her behalf.",
      "He must deliver the remaining parcels before the shift bell and can stay for a few lines of conversation. He does not know Ning's sister and cannot contact her for Ning.",
    ],
    voices: [
      "Ning leaves half a beat when she speaks. She explains herself through the particulars of mending umbrellas and tends to leave feelings unnamed.",
      "He speaks in short bursts and grounds abstractions in something someone can do now. When rushed, she drops the subject of a sentence.",
    ],
    turns: [
      "I stay seated and ask Ning, “Was there a moment while you were closing up today when you especially missed your sister?”",
      "I stay seated and ask both of them, “What ordinary thing feels most like missing someone? You can give different answers.”",
      "I tell Ning, “I only wanted to listen. Would you like to sit just like this for a while tonight?” I don't make any arrangements.",
      "I sit here a little longer and listen until they're finished. I make no plans, and leave any farewell words for me to say.",
    ],
  },
  {
    id: "travel-zh",
    locale: "zh-CN",
    topic: "travel",
    title: "石渠岔口",
    opening:
      "白色界桩旁，石渠沿路发出低低的水声。你在岔口的歇脚石上，身旁是铺路工闻和运货人白。窄便道顺渠向上，左边小坡早已封起。",
    fixed: [
      "你在白色界桩旁。你的当前路标是「岔口歇脚石」。沿公开渠边便道可以安全走到下一个路标「双孔石桥」，前后没有其他路标、费用、门锁或允许条件。",
      "从岔口抄近路的小坡已经塌陷并封闭。闻不会建议走封闭小坡，白也无权重开。",
      "双孔石桥的岔口一边有一块白石，人在桥头看得见。桥对面的小径弯过芦苇，桥头看不见弯后的地形。必须玩家自己决定是否过桥。",
    ],
    voices: [
      "铺路工闻想让便道好走，先说能不能走，再解释一处实地特征。",
      "运货人白惦记还没卸的东西，愿意指路，爱按行李搬运的手感形容坡度。",
    ],
    turns: [
      "我留在歇脚石旁，问闻：“封起来的小坡能当近路吗？”只问，不走。",
      "我仍在原地，问闻和白：“沿渠走到第一座桥，路上最好留意什么？”",
      "我沿公开的渠边便道走到双孔石桥的近侧桥头，停在那里。略过普通赶路过程，不上桥。",
      "我留在这边桥头，只从这里看看。能判断桥对面小径弯过去以后通向哪儿吗？我没说出口，也不过桥。",
    ],
    stops: ["岔口歇脚石", "双孔石桥"],
  },
  {
    id: "travel-en",
    locale: "en",
    topic: "travel",
    title: "The cut beside the stone race",
    opening:
      "Water murmurs in the stone race beside a white boundary post. You sit at a resting stone at the fork, beside Wen the road mender and Bai the hauler. A narrow path follows the water uphill. The shorter slope to the left is already closed.",
    fixed: [
      "You are by the white boundary post. Your current waypoint is “Fork resting stone”. The public path along the race leads safely to the next waypoint, “Twin-arch bridge”, with no other waypoints, fees, locks, or permissions in between.",
      "The shortcut up the slope has collapsed and is closed. Wen will not advise using it, and Bai has no authority to reopen it.",
      "There is a white stone on the fork side of the twin-arch bridge, visible from the near bridgehead. Across the bridge the path bends around reeds. What lies past the bend cannot be seen from the near bridgehead. The player decides whether to cross.",
    ],
    voices: [
      "Wen the road mender wants the public trail kept walkable. Wen gives a yes or no first, then one physical detail.",
      "Bai the hauler has a load to unload and is happy to point out the way. Bai describes a slope by how it would feel under a load.",
    ],
    turns: [
      "I stay at the resting stone and ask Wen, “Can I use the closed slope as a shortcut?” I'm only asking. I don't set off.",
      "Still at the stone, I ask Wen and Bai, “What should I look out for on the way to the first bridge along the race?”",
      "I take the public path along the race to the near bridgehead of the twin-arch bridge and stop there. Skip the routine walk. I don't step onto the bridge.",
      "I stay at this bridgehead and only look from here. Can I tell where the path on the other side goes after the bend? I don't say that aloud or cross the bridge.",
    ],
    stops: ["Fork resting stone", "Twin-arch bridge"],
  },
].map((scene) => ({
  ...scene,
  situation: [...scene.fixed, ...scene.voices],
}));

export function packageFiles(scene) {
  const en = scene.locale === "en";
  const document = (id, ref, title, summary, value) =>
    stringify({
      $document: { id, ref, title, summary, aliases: [] },
      ...value,
    });
  const files = [
    { path: "opening.md", contents: scene.opening + "\n" },
    {
      path: "world/current-situation.yaml",
      contents: document(
        "situation.current",
        "current-situation",
        en ? "Current situation" : "当前情境",
        en
          ? "Established constraints and circumstances"
          : "已经成立的规则和情形",
        {
          rules: scene.fixed.slice(scene.stops ? 1 : 0),
          ...(!scene.stops && { situation: scene.fixed[0] }),
        },
      ),
    },
    {
      path: "control/frame.yaml",
      contents: stringify({
        format: "narraeon.world-frame/v1",
        bindings: { currentSituation: "situation.current" },
        instructions: [{ markdown: "voices.md" }],
        context: [
          { slot: { kind: "current_situation" } },
          ...(scene.stops
            ? [{ slot: { kind: "document", document: "@route-progress" } }]
            : []),
          { slot: { kind: "additional_materials" } },
        ],
      }),
    },
    {
      path: "control/voices.md",
      contents:
        (en ? "# Character voices\n\n" : "# 人物写法\n\n") +
        scene.voices.map((voice) => "- " + voice + "\n").join(""),
    },
  ];
  if (scene.stops) {
    files.push(
      {
        path: "world/route.yaml",
        contents: document(
          "route.progress",
          "route-progress",
          en ? "Route progress" : "行程进度",
          en ? "Player’s route and current waypoint" : "玩家的路线和当前路标",
          {
            waypoint: scene.stops[0],
            leg: en
              ? "The white boundary post at the fork and the near bridgehead are linked by a safe public path beside the race. There are no intermediate waypoints, locks, fees, or required permissions."
              : "白色界桩所在的岔口和近侧桥头之间，有一条安全的公开渠边便道。沿途没有其他路标、门锁、费用或允许条件。",
          },
        ),
      },
      {
        path: "control/player-views.yaml",
        contents: stringify({
          format: "narraeon.player-views/v1",
          views: [
            {
              id: "route",
              title: en ? "Route" : "行程",
              items: [
                {
                  id: "waypoint",
                  label: en ? "Current waypoint" : "当前路标",
                  select: {
                    document: "@route-progress",
                    locator: { yaml: ["waypoint"] },
                  },
                },
              ],
            },
          ],
        }),
      },
    );
  } else {
    files.push({
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    });
  }
  return files;
}
