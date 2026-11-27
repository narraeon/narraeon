import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const qingzhouTalesEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `Three days of autumn rain have turned the western road outside Qingzhou to mud. When you fold your umbrella and step into the Westgate Teahouse, the paper lanterns under the eaves sway in the damp breeze, and the kettle fills the room with the scent of ginger tea, wet firewood, and mugwort.

Tea-Master Sun has barely filled your bowl when young Constable Shen Qing sighs at the window table and slaps a rain-spotted dispatch onto the wood. “Another merchant lost his birth-tally at the Dry-Well Post last night. Slept soundly in the common room, not a single copper coin touched—only the paper he kept close, with the date and hour of his birth, was gone. That makes three this month.”

By the brazier, an elderly wandering Daoist, Master Xuanwei, lifts his eyes and sets a hairline-cracked peachwood talisman back on his tray. “Someone at the Dry-Well Post is stealing the fortune of the living. And last night, zither music rose from the ruined Lanruo Temple outside town again. It sounded less like a ghost calling for blood and more like someone holding something down.”

At the next table, a young woman in a plain white cloak pauses mid-page at the word “Lanruo.” She raises calm, gracious eyes to you. “Yours is a new face, traveler. Are you visiting friends in Qingzhou, or passing through Willow Brook? The paths are slick tonight. Will you rest here at the teahouse, or ask more about one of these tales first?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.qingzhou-tales
  ref: current-situation
  title: Current situation in Qingzhou
  summary: Tracks the current time and place, who is present, and what awaits a response on the Qingzhou journey.
  aliases: []
background:
  Time: Late autumn, rainy evening, first watch (Night 1)
  Place: Westgate Teahouse outside Qingzhou
  Weather and omens: Just before Frost’s Descent; steady rain and mist along the hills
Present:
  - { $ref: character.qingzhou-traveler }
  - { $ref: character.qingzhou-shen }
  - { $ref: character.qingzhou-xuanwei }
  - { $ref: character.qingzhou-suxin }
  - { $ref: character.qingzhou-sun }
Awaiting a response:
  Speaker: { $ref: character.qingzhou-suxin }
  Decision: The traveler can say what brings them here and decide whether to rest at the teahouse or ask about a tale first.
  Scene: Shen Qing has the Dry-Well Post dispatch on his table. Master Xuanwei has set his cracked peachwood talisman back on his tray. The woman in the white cloak looks up from her book and waits for an answer.
`,
  },
  {
    path: "world/characters/traveler.yaml",
    contents: `$document:
  id: character.qingzhou-traveler
  ref: protagonist
  title: The traveler
  summary: A wandering scholar or traveling physician passing through Qingzhou; name, background, and convictions are open to the player.
  aliases: []
Vitality and composure:
  Body: Sound (chilled by the autumn rain)
  Composure: Clear (untouched by illusion)
  Ill omen: None
Satchel:
  - Travel pass and scholar’s/physician’s notebook
  - Half of an heirloom bronze mirror (cloud-and-thunder pattern on the back)
  - Small cinnabar brush, sheets of yellow paper, and a tinder tube
  - A few taels of silver and dry rations
Bearing: Free to mediate between mortals and spirits with compassion, pursue the human culprit behind the dark art, or observe as a chronicler.
`,
  },
  {
    path: "world/characters/shen-qing.yaml",
    contents: `$document:
  id: character.qingzhou-shen
  ref: shen-qing
  title: Constable Shen Qing
  summary: A young Qingzhou county constable who relies on witnesses and physical evidence.
  aliases: [Shen Qing]
Motive: Three merchants lost their birth-tallies at the Dry-Well Post in the calendar month of the first teahouse night. The latest theft was the night before. Shen Qing doubts that spirits are to blame and suspects an insider working with a hedge sorcerer.
Deadline: The magistrate gives him five full days from the start of the first watch on Night 1 at the Westgate Teahouse. The deadline falls at the start of the first watch on Night 6.
Behavior: Direct and evidence-minded; if the player brings concrete leads, he will share old county records or join a night visit.
Knowledge:
  Knows: Each victim drank warm osmanthus tea served by the postmaster and heard faint bronze bells from the courtyard’s dry well on the night their tally vanished.
  Limits: Has not connected the missing tallies to Willow Brook Manor or Lanruo Temple, and does not know Bai Suxin’s true nature.
`,
  },
  {
    path: "world/characters/xuanwei.yaml",
    contents: `$document:
  id: character.qingzhou-xuanwei
  ref: xuanwei
  title: Master Xuanwei
  summary: An elderly wandering Daoist versed in talismans and old steles.
  aliases: [Xuanwei]
Motive: During the month leading up to the first teahouse night, he noticed fortune draining unnaturally around western Qingzhou and came to suspect a human-built fate-siphoning rite. He wants to learn whether the Lanruo zither is predatory or protective.
Behavior: Measured and fond of tea-table conversation; if the player acts with integrity, he may offer a calming charm or teach how to tell benign spirit-aura from malice.
Knowledge:
  Knows: On the night before the first teahouse night, his peachwood talisman cracked without warning as he passed the Dry-Well Post’s outer wall. He takes it as a sure sign of a deliberately laid fate-stealing ward inside.
  Observation: Notices a clean herbal fragrance and faint spirit-aura around Bai Suxin, with no taint of blood or malice, so he holds his hand and watches quietly.
`,
  },
  {
    path: "world/characters/bai-suxin.yaml",
    contents: `$document:
  id: character.qingzhou-suxin
  ref: bai-suxin
  title: Bai Suxin
  summary: A courteous traveler in a white cloak who frequents the roads west of Qingzhou.
  aliases: [Miss Bai]
Identity: A century-old fox spirit of Qingqiu who quietly watches over the Zhou household at Willow Brook.
Motive: About ten years before the first teahouse night, Scholar Zhou Yan’s father saved her when she was wounded. Before the opening, she sensed miasma from the Dry-Well Post draining Willow Brook’s fortune, weakening Zhou Yan, and alarming his bride. She came to shield the household and find the culprit.
Behavior: Courteous, wary of Master Xuanwei at first, yet deeply loyal to kindness and kept promises; if treated without prejudice, she will speak candidly and lend her aid.
Knowledge:
  Knows: She is the one playing the zither at Lanruo Temple each night to hold back the creeping miasma; she also knows Zhou Yan’s new bride is a gentle spirit rather than a mortal (see @lanruo-records and @willow-manor-records).
  Limits: Does not yet know who is operating the fate-siphoning rite at the Dry-Well Post.
`,
  },
  {
    path: "world/characters/zhou-yan.yaml",
    contents: `$document:
  id: character.qingzhou-zhou
  ref: zhou-yan
  title: Scholar Zhou Yan
  summary: A scholar of modest means who lives at Willow Brook Old Manor.
  aliases: [Zhou Yan]
Location: { $ref: location.qingzhou-willow-manor }
Motive: He married the gentle A-Heng about half a year before the first teahouse night. He cherishes her and wants to protect her from gossip, though he has noticed she never faces a bronze mirror and casts a faint shadow by lamplight. During the month before the first teahouse night he often felt weary, and by the opening he was dreaming of a dry well every night. He wants to know why.
Knowledge:
  Knows: A-Heng brought only a single old portrait scroll when they wed. It hangs on the north wall of his study. In the nights leading up to the opening, it would often give off a faint lotus scent around midnight, and his chest would grow heavy.
`,
  },
  {
    path: "world/characters/tea-master-sun.yaml",
    contents: `$document:
  id: character.qingzhou-sun
  ref: tea-master-sun
  title: Tea-Master Sun
  summary: Keeper of the Westgate Teahouse and a source of road lore outside Qingzhou.
  aliases: [Old Sun]
Motive: Wishes the western road quiet again so merchants dare stop on rainy nights.
Knowledge:
  Old gossip: Qian Wenyuan, a county registry clerk, was dismissed about ten years before the first teahouse night for altering land deeds and birth rolls. Later, people said he was writing letters for travelers around the Dry-Well Post.
  Routine: Keeps two dry guest rooms upstairs and a sketched map of the western suburbs behind the counter.
`,
  },
  {
    path: "world/locations/westgate-teahouse.yaml",
    contents: `$document:
  id: location.qingzhou-teahouse
  ref: westgate-teahouse
  title: Westgate Teahouse
  summary: The traveler’s hub outside Qingzhou where merchants, constables, and wanderers trade news out of the rain.
  aliases: []
Layout: A warm brazier, tea tables, and a road sketch downstairs; two dry guest rooms upstairs.
Use: Rest to recover Body and Composure, ask Old Sun about local history, compare notes with Shen Qing or Xuanwei, or set out toward the four sites.
`,
  },
  {
    path: "world/locations/lanruo-ruin.yaml",
    contents: `$document:
  id: location.qingzhou-lanruo
  ref: lanruo-ruin
  title: Ruined Lanruo Temple
  summary: An abandoned hill temple deep in the pines outside Qingzhou.
  aliases: []
Scene: Broken steles half-buried in weeds, yet the side hall is remarkably dry, holding half a stick of calming incense and a few white plum petals on a stone table.
Clues: Inspecting the incense ash and carvings on the zither table shows a gentle warding resonance rather than a haunting (see @lanruo-records).
`,
  },
  {
    path: "world/locations/willow-manor.yaml",
    contents: `$document:
  id: location.qingzhou-willow-manor
  ref: willow-manor
  title: Willow Brook Old Manor
  summary: An old whitewashed manor beside Willow Brook.
  aliases: []
Scene: An old willow overhangs the water. An antique portrait scroll of a lady hangs in the study, and every bronze mirror in the house is draped in plain silk. Zhou Yan and his bride A-Heng live here.
Clues: Examining the room with the heirloom bronze mirror or Xuanwei’s charm reveals no malice in A-Heng—instead, a hidden paper effigy slipped beneath Zhou Yan’s pillow is draining his vitality (see @willow-manor-records).
`,
  },
  {
    path: "world/locations/dry-well-post.yaml",
    contents: `$document:
  id: location.qingzhou-dry-well
  ref: dry-well-post
  title: Dry-Well Post
  summary: An old travelers’ post on the road west of Qingzhou.
  aliases: []
Scene: A quiet letter-writer named Qian Wenyuan dozes behind the desk in the dim lamplight. The courtyard’s stone well had been dry for about ten years by the first teahouse night. Dark moss rings it, and a loose brick sits three feet down the shaft.
Clues: Lifting the loose brick or inspecting Qian Wenyuan’s desk box exposes the three missing birth-tallies, silk-strung bronze bells, and a complete fate-siphoning ward (see @dry-well-post-records).
`,
  },
  {
    path: "world/locations/city-god-shrine.yaml",
    contents: `$document:
  id: location.qingzhou-shrine
  ref: city-god-shrine
  title: Old City God Shrine
  summary: A quiet old shrine on the western edge of Qingzhou.
  aliases: []
Clues: The caretaker keeps old burial rolls and registry copies. Two entries from about ten years before the first teahouse night record Qian Wenyuan’s dismissal for embezzling relief silver and Zhou Yan’s father paying to bury a nameless orphan girl with a stone marker. The records can help link the Willow Brook scroll and the Lanruo debt.
Use: Drawing a fortune lot or checking the old rolls grounds the moral ties behind all three tales.
`,
  },
  {
    path: "world/case/rumor-ledger.yaml",
    contents: `$document:
  id: case.qingzhou-rumor-ledger
  ref: rumor-ledger
  title: Qingzhou ledger
  summary: Records the tales the traveler has heard, the questions still open, and their dealings with companions.
  aliases: []
Known rumors:
  Missing tallies: When the traveler first met Shen Qing at the Westgate Teahouse, he reported three thefts of merchants’ birth-tallies at the Dry-Well Post that month. In the latest theft, the night before they met, the merchant’s money was untouched.
  Lanruo zither: Master Xuanwei said zither music rose from the ruined Lanruo Temple again on the night before they first met at the teahouse. To him it sounded like someone holding something down.
  Woman in a white cloak: She paused mid-page at the word “Lanruo,” then asked whether the traveler was visiting friends in Qingzhou or passing through Willow Brook.
Unresolved threads:
  - Who is stealing birth-tallies at the Dry-Well Post, and to what end?
  - Who played the zither at Lanruo Temple, and why?
  - Why did the woman in the white cloak pause mid-page when she heard “Lanruo”?
Companions & trust:
  Constable Shen Qing: Newly met. Spoke of the missing birth-tallies at the teahouse.
  Master Xuanwei: Newly met. Spoke of the zither music at the teahouse.
  Woman in a white cloak: Newly met. Asked what brought the traveler here and what they planned to do.
`,
  },
  {
    path: "world/archives/lanruo-records.yaml",
    contents: `$document:
  id: archive.qingzhou-lanruo-debt
  ref: lanruo-records
  title: Lanruo Temple records
  summary: Records of people and past events connected to the ruined temple.
  aliases: []
Facts:
  Old debt: Bai Suxin is a fox spirit. About ten years before the first teahouse night, Zhou Yan’s father sheltered her at Lanruo Temple, healed her with herbs, and kept her secret.
  Warding music: In the month leading up to the first teahouse night, she sensed a fate-draining miasma creeping downstream each night from the Dry-Well Post toward Willow Brook. She began playing a warding air each night at the ruined temple at a cost to her own strength. She came in disguise to the Westgate Teahouse to track the rite to its source.
`,
  },
  {
    path: "world/archives/willow-manor-records.yaml",
    contents: `$document:
  id: archive.qingzhou-mirror-bride
  ref: willow-manor-records
  title: Willow Brook Old Manor records
  summary: Records of people and past events connected to the manor.
  aliases: []
Facts:
  Identity: A-Heng is the gentle ghost of an orphan girl who died of illness on the Qingzhou road about ten years before the first teahouse night. Grateful to Zhou Yan’s father for giving her a proper burial, she bound herself to the old scroll to care for his son. She covers the mirrors so her faint reflection will not frighten him. She has harmed no one.
  Real cause: Qian Wenyuan slipped a paper fate-effigy beneath Zhou Yan’s pillow while writing a family letter for him about half a month before the first teahouse night. It directs the household’s fortune toward the Dry-Well Post and causes Zhou Yan’s fatigue and dreams.
`,
  },
  {
    path: "world/archives/dry-well-post-records.yaml",
    contents: `$document:
  id: archive.qingzhou-borrowed-fate
  ref: dry-well-post-records
  title: Dry-Well Post records
  summary: Records of people, past events, and objects connected to the post.
  aliases: []
Facts:
  Culprit: Qian Wenyuan, the quiet letter-writer at the post, is the disgraced clerk dismissed about ten years before the first teahouse night for falsifying land deeds and birth rolls and skimming relief silver.
  Method and evidence: Using a fragment of a forbidden fate-siphoning rite, he uses his letter-writing work and drugged osmanthus tea to steal travelers’ birth-tallies as well as Zhou Yan’s. He seals them with silk-strung bronze bells behind a loose brick three feet down the dry well to siphon good fortune toward his own reinstatement.
`,
  },
  gameplayFile({ mode: "tabletop", scheme: "bag" }),
  ...storyControlFiles(
    "en",
    "westgate-teahouse",
    `# Night Tales of Qingzhou (Chaos Bag Long-Form Strange Tales)

Write in the poised, humane register of classic Chinese strange tales: not splatter horror, but a world where mortals, foxes, and ghosts cross paths over gratitude, grief, and human greed. Let the player decide which rumor to pursue first, whom to trust, and how to balance law with compassion.

## Chaos Bag Resolution & State Maintenance

- Narrate ordinary conversation, travel, and clear observations without drawing from the Chaos bag. Call for a Chaos bag draw only when venturing into the ruined temple at night, piercing illusions, prying into the dry well, persuading guarded allies under pressure, or confronting the fate-siphoning ward—interpreting the draw as fortune, serendipity, or an eerie twist.
- Use the default bag by omitting tokens in bag_check. Set numbers for the action in front of the traveler without adding numerical character stats.
- Start at value 3. Use 4 when relevant preparation, gear, or an ally helps, and 2 when exhaustion or another limitation hinders the traveler.
- For a risky action, set difficulty 2 if conditions favor the traveler, 3 for a clear obstacle, or 4 for strong pressure or danger. Set the goal and numbers before drawing.
- For example, use value 4 and difficulty 3 to keep your footing on rain-slick stone while entering the ruined temple’s side hall at night with light from your tinder tube. Use value 3 and difficulty 4 to lean out alone in the rain and examine the inside of the dry well.
- Always fail forward: a harsh draw brings an ill omen, lost time, alerted suspicions at the post, or a temporary misunderstanding among allies, never a dead end.
- Update @protagonist when Body, Composure, Ill omen, or Satchel items change. As the scene moves, update the body of @current-situation and keep its title and summary stable.
- Keep @rumor-ledger to what the traveler has heard, seen, or verified. Attribute rumors to their speakers and use the traveler’s own description of anyone who has yet to introduce themselves. Date durable clues relative to a fixed event such as Night 1 at the Westgate Teahouse.

## On-Demand Reading & Unfolding Causality

- Beyond the @westgate-teahouse hub, read the other four locations and the three archive documents (@lanruo-records, @willow-manor-records, @dry-well-post-records) on demand via context_read only when the player visits or probes those leads—never spoil them early.
- Let the player return to the teahouse across several days to rest, compare notes, ease the quiet tension between Master Xuanwei and Bai Suxin, and reach an ending shaped by their own judgment.
`,
    ["rumor-ledger"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "traveler-status",
          title: "Traveler",
          items: [
            {
              id: "vitality-mind",
              label: "Vitality & composure",
              document: "protagonist",
              locator: ["Vitality and composure"],
            },
            {
              id: "satchel",
              label: "Satchel",
              document: "protagonist",
              locator: ["Satchel"],
            },
          ],
        },
        {
          id: "qingzhou-ledger",
          title: "Qingzhou ledger",
          items: [
            {
              id: "known-rumors",
              label: "Known rumors",
              document: "rumor-ledger",
              locator: ["Known rumors"],
            },
            {
              id: "unresolved-threads",
              label: "Unresolved threads",
              document: "rumor-ledger",
              locator: ["Unresolved threads"],
            },
            {
              id: "companion-trust",
              label: "Companions & trust",
              document: "rumor-ledger",
              locator: ["Companions & trust"],
            },
          ],
        },
      ],
    },
  ),
];
