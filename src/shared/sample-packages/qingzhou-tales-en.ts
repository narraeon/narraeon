import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const qingzhouTalesEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `Three days of autumn rain have turned the western road outside Qingzhou to mud. When you fold your umbrella and step into the Westgate Teahouse, the paper lanterns under the eaves sway in the damp breeze, and the kettle fills the room with the scent of ginger tea, wet firewood, and mugwort.

Tea-Master Sun has barely filled your bowl when young Constable Shen Qing sighs at the window table and slaps a rain-spotted dispatch onto the wood. “Another merchant lost his birth-tally at the Dry-Well Post last night. Slept soundly in the common room, not a single copper coin touched—only the personal paper with his birth hour gone. That makes three this month.”

By the brazier, an elderly wandering Daoist, Master Xuanwei, lifts his eyes and sets a hairline-cracked peachwood talisman back on his tray. “Whoever works the Dry-Well Post is stealing living fortune. Meanwhile, the ruined Lanruo Temple outside town played zither music at midnight again—not like a ghost calling for blood, more like someone holding something down.”

At the next table, a young woman in a plain white cloak pauses mid-page at the word “Lanruo.” She raises calm, gracious eyes to you. “You’re new to the west road, traveler—bound for Qingzhou to visit friends, or passing by Willow Brook? The paths are slick tonight. Will you rest here at the teahouse, or ask more about one of these tales first?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.qingzhou-tales
  ref: current-situation
  title: Westgate Teahouse on a rainy night
  summary: Three quietly linked tales surface at once in the teahouse, leaving the traveler to choose where to begin.
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
  Words: You’re new to the west road, traveler—bound for Qingzhou to visit friends, or passing by Willow Brook? The paths are slick tonight. Will you rest here at the teahouse, or ask more about one of these tales first?
  Scene: Shen Qing’s dispatch about the stolen birth-tallies lies open on his table; Master Xuanwei turns his cracked peachwood talisman by the brazier; Bai Suxin closes her book and watches you calmly.
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
  summary: Young county runner of Qingzhou, practical and skeptical of ghosts, assigned to the stolen birth-tally cases.
  aliases: [Shen Qing]
Motive: Three merchants have lost their birth-tallies at the Dry-Well Post in a month and the magistrate gave him five days to solve it; he suspects an insider colluding with a hedge sorcerer rather than spirits.
Behavior: Direct and evidence-minded; if the player brings concrete leads, he will share old county records or join a night visit.
Knowledge:
  Knows: All three victims drank warm osmanthus tea served at the Dry-Well Post and heard faint bronze bells from the courtyard’s dry well the night their tallies vanished.
  Limits: Has not connected the missing tallies to Willow Brook Manor or Lanruo Temple, and does not know Bai Suxin’s true nature.
`,
  },
  {
    path: "world/characters/xuanwei.yaml",
    contents: `$document:
  id: character.qingzhou-xuanwei
  ref: xuanwei
  title: Master Xuanwei
  summary: Wandering Daoist versed in talismans and old steles, wise enough not to slay every spirit on sight.
  aliases: [Xuanwei]
Motive: Senses the fortune around western Qingzhou draining unnaturally and suspects a human-built fate-siphoning rite; also wants to verify whether the Lanruo zither is predatory or protective.
Behavior: Measured and fond of tea-table conversation; if the player acts with integrity, he may offer a calming charm or teach how to tell benign spirit-aura from malice.
Knowledge:
  Knows: His peachwood talisman cracked without warning last night while passing the outer wall of the Dry-Well Post—a sure sign of a deliberate fate-stealing ward inside.
  Observation: Notices a clean herbal fragrance and faint spirit-aura around Bai Suxin, with no taint of blood or malice, so he holds his hand and watches quietly.
`,
  },
  {
    path: "world/characters/bai-suxin.yaml",
    contents: `$document:
  id: character.qingzhou-suxin
  ref: bai-suxin
  title: Bai Suxin
  summary: Gracious woman in a white cloak—in truth a century-old fox spirit quietly watching over the Zhou household at Willow Brook.
  aliases: [Miss Bai]
Motive: Ten years ago, Scholar Zhou Yan’s late father saved her when she was wounded; sensing malignant miasma from the Dry-Well Post draining Willow Brook’s fortune and weakening Zhou Yan, she came to shield the household and find the true culprit.
Behavior: Courteous, wary of Master Xuanwei at first, yet deeply loyal to kindness and kept promises; if treated without prejudice, she will speak candidly and lend her aid.
Knowledge:
  Knows: She is the one playing the zither at Lanruo Temple each night to hold back the creeping miasma; she also knows Zhou Yan’s new bride is a gentle spirit rather than a mortal (see @lanruo-zither-debt and @mirror-bride-truth).
  Limits: Does not yet know who is operating the fate-siphoning rite at the Dry-Well Post.
`,
  },
  {
    path: "world/characters/zhou-yan.yaml",
    contents: `$document:
  id: character.qingzhou-zhou
  ref: zhou-yan
  title: Scholar Zhou Yan
  summary: Modest scholar of Willow Brook Manor, wed half a year ago to his quiet wife A-Heng, lately plagued by fatigue and dreams.
  aliases: [Zhou Yan]
Location: { $ref: location.qingzhou-willow-manor }
Motive: Cherishes his gentle wife A-Heng, though he has noticed she never faces a bronze mirror and casts a faint shadow by lamplight; he wants to protect her from gossip while learning why he dreams of a dry well every night.
Knowledge:
  Knows: A-Heng brought only a single old portrait scroll when they wed, now hanging on the north wall of his study; lately it carries a faint lotus scent at midnight while his chest grows heavy.
`,
  },
  {
    path: "world/characters/tea-master-sun.yaml",
    contents: `$document:
  id: character.qingzhou-sun
  ref: tea-master-sun
  title: Tea-Master Sun
  summary: Keeper of the Westgate Teahouse, walking archive of ten years of road gossip outside Qingzhou.
  aliases: [Old Sun]
Motive: Wishes the western road quiet again so merchants dare stop on rainy nights.
Knowledge:
  Old gossip: Remembers a disgraced county registry clerk named Qian Wenyuan dismissed ten years ago for altering land deeds and birth rolls, later rumored to be writing letters for travelers around the Dry-Well Post.
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
  summary: Abandoned hill temple deep in the pines, where clear zither music echoes after midnight.
  aliases: []
Scene: Broken steles half-buried in weeds, yet the side hall is remarkably dry, holding half a stick of calming incense and a few white plum petals on a stone table.
Clues: Inspecting the incense ash and carvings on the zither table shows a gentle warding resonance rather than a haunting (see @lanruo-zither-debt).
`,
  },
  {
    path: "world/locations/willow-manor.yaml",
    contents: `$document:
  id: location.qingzhou-willow-manor
  ref: willow-manor
  title: Willow Brook Old Manor
  summary: Whitewashed scholar’s courtyard beside the brook, where every bronze mirror is draped in plain silk.
  aliases: []
Scene: An old willow overhangs the water; inside the study hangs an antique portrait scroll of a lady. Zhou Yan and his bride A-Heng live here.
Clues: Examining the room with the heirloom bronze mirror or Xuanwei’s charm reveals no malice in A-Heng—instead, a hidden paper effigy slipped beneath Zhou Yan’s pillow is draining his vitality (see @mirror-bride-truth).
`,
  },
  {
    path: "world/locations/dry-well-post.yaml",
    contents: `$document:
  id: location.qingzhou-dry-well
  ref: dry-well-post
  title: Dry-Well Post
  summary: Weathered roadside inn with a stone well in the back courtyard that has been dry for ten years.
  aliases: []
Scene: Dim oil lamps; a quiet letter-writer named Qian Wenyuan dozes behind the desk. Dark moss rings the dry well, and a loose brick sits three feet down the shaft.
Clues: Lifting the loose brick or inspecting Qian Wenyuan’s desk box exposes the three missing birth-tallies, silk-strung bronze bells, and a complete fate-siphoning ward (see @borrowed-fate-ledger).
`,
  },
  {
    path: "world/locations/city-god-shrine.yaml",
    contents: `$document:
  id: location.qingzhou-shrine
  ref: city-god-shrine
  title: Old City God Shrine
  summary: Quiet shrine on the western edge of town whose caretaker keeps burial rolls and old registry copies.
  aliases: []
Clues: Ten-year-old copies record both Qian Wenyuan’s dismissal for embezzling relief silver and Zhou Yan’s father paying to bury a nameless orphan girl with a stone marker—linking the Willow Brook scroll and the Lanruo debt.
Use: Drawing a fortune lot or checking the old rolls grounds the moral ties behind all three tales.
`,
  },
  {
    path: "world/case/rumor-ledger.yaml",
    contents: `$document:
  id: case.qingzhou-rumor-ledger
  ref: rumor-ledger
  title: Qingzhou ledger
  summary: Records only rumors, causal threads, and trust actually learned by the player—never premature secrets.
  aliases: []
Known rumors:
  Missing tallies: Shen Qing reports three merchants lost their birth-tallies at the Dry-Well Post this month while their silver was untouched.
  Lanruo zither: Master Xuanwei heard zither music from the ruined Lanruo Temple last night, sounding more like containment than menace.
  Willow Brook lead: Bai Suxin reacted subtly to the name Lanruo and asked whether you are bound for Willow Brook.
Unresolved threads:
  - Who is stealing birth-tallies at the Dry-Well Post, and to what end?
  - Who plays the zither at Lanruo Temple, and how is Bai Suxin involved?
  - What quiet secret rests inside Willow Brook Old Manor?
Companions & trust:
  Constable Shen Qing: Newly met, willing to share case facts
  Master Xuanwei: Newly met, calm and observant
  Bai Suxin: Newly met, courteous yet guarded
`,
  },
  {
    path: "world/archives/lanruo-zither-debt.yaml",
    contents: `$document:
  id: archive.qingzhou-lanruo-debt
  ref: lanruo-zither-debt
  title: The Lanruo zither and an old debt
  summary: Background record connecting the midnight zither at Lanruo Temple and the Zhou family.
  aliases: []
Facts:
  Old debt: Bai Suxin is a fox spirit sheltered and healed ten years ago at Lanruo Temple by Zhou Yan’s late father, who never betrayed her secret.
  Warding music: Sensing a fate-draining miasma drifting downstream from the Dry-Well Post toward Willow Brook, she plays a warding air at the ruined temple each night at cost to her own strength, and came to Westgate Teahouse to trace the source.
`,
  },
  {
    path: "world/archives/mirror-bride-truth.yaml",
    contents: `$document:
  id: archive.qingzhou-mirror-bride
  ref: mirror-bride-truth
  title: Why the Willow Brook bride avoids mirrors
  summary: Who A-Heng truly is and what is actually draining Zhou Yan’s strength.
  aliases: []
Facts:
  Identity: A-Heng is the gentle ghost of an orphan girl who died on the Qingzhou road ten years ago; grateful to Zhou Yan’s father for giving her a proper burial, she bound herself to the old scroll to care for his son, covering the mirrors only so her faint reflection would not frighten him.
  Real cause: Zhou Yan’s nightly fatigue comes not from A-Heng, but from a paper fate-effigy slipped beneath his pillow by Qian Wenyuan half a month ago.
`,
  },
  {
    path: "world/archives/borrowed-fate-ledger.yaml",
    contents: `$document:
  id: archive.qingzhou-borrowed-fate
  ref: borrowed-fate-ledger
  title: The Dry-Well borrowed-fate ledger
  summary: The culprit, method, and physical evidence behind the stolen birth-tallies.
  aliases: []
Facts:
  Culprit: Qian Wenyuan, the quiet letter-writer at the post, is the disgraced clerk dismissed ten years ago for forging deeds and skimming relief silver.
  Method and evidence: Using a fragment of a forbidden fate-siphoning rite, he drugs travelers’ tea, steals their birth-tallies, and seals them with silk-strung bronze bells behind a loose brick three feet down the dry well to siphon good fortune toward his own reinstatement.
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
- Always fail forward: a harsh draw brings an ill omen, lost time, alerted suspicions at the post, or a temporary misunderstanding among allies, never a dead end.
- Update @protagonist whenever Body, Composure, Ill omen, or Satchel items change; update @current-situation as time and location move; record only player-verified leads in @rumor-ledger.

## On-Demand Reading & Unfolding Causality

- Beyond the @westgate-teahouse hub, read the other four locations and the three archive documents (@lanruo-zither-debt, @mirror-bride-truth, @borrowed-fate-ledger) on demand via context_read only when the player visits or probes those leads—never spoil them early.
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
