import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const treasureIslandEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `Sea fog clings to Bristol Quay, thick with tar and salt. The schooner Hispaniola creaks gently on the rising tide, deck lanterns stretching the sailors’ shadows across the planks. At first light, she sails for the South Atlantic in search of an island marked only on an old chart.

Hired by Dr. Livesey and Squire Trelawney as the expedition’s junior chartmaker, you have just come up from checking provisions in the hold—where you caught two newly signed hands comparing a torn corner of an island sketch in low voices. The moment they saw you, they pocketed the scrap and laughed it off as southern star bearings.

On the main deck, straight-backed Captain Smollett folds a crew roster into his coat and lowers his voice to you. “I don’t like this cruise, young hand. Every man aboard seems to know we’re hunting treasure except the captain—and the powder and muskets are stowed forward right under the crew’s hammocks.”

Before you can answer, the galley curtain parts. One-legged ship’s cook Long John Silver swings out on his crutch, a green parrot perched on his shoulder and steaming mugs in hand. “Fog’s biting tonight, Captain! Brought a warm dram for our new chartmaker—every lad aboard’s itching for a fair breeze come dawn!”

Smollett ignores the mug and glances sidelong at you. “You just came up from the hold. Last night before we weigh anchor—do you want a private word with me and the Doctor first, or would you rather mingle with Silver and the hands on deck?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.treasure-island
  ref: current-situation
  title: Eve of sailing aboard the Hispaniola
  summary: The schooner sails at dawn; Captain Smollett distrusts the newly recruited crew while Silver offers a warm welcome.
  aliases: []
background:
  Time: Night 1, eve of sailing (Bristol Quay)
  Place: Main deck of the Hispaniola and Bristol jetty
  Voyage act: Act I — Eve of sailing (still at anchor)
Present:
  - { $ref: character.ti-protagonist }
  - { $ref: character.ti-smollett }
  - { $ref: character.ti-silver }
Awaiting a response:
  Speaker: { $ref: character.ti-smollett }
  Words: You just came up from the hold. Last night before we weigh anchor—do you want a private word with me and the Doctor first, or would you rather mingle with Silver and the hands on deck?
  Scene: Captain Smollett has just voiced his distrust of the crew and the forward powder stowage; Silver stands a few paces away with warm rum and an easy smile.
`,
  },
  {
    path: "world/characters/protagonist.yaml",
    contents: `$document:
  id: character.ti-protagonist
  ref: protagonist
  title: Junior chartmaker
  summary: Young chartmaker hired aboard the Hispaniola; name, background, and loyalties are open to the player.
  aliases: []
Condition:
  Vigor: 12 / 12 (Uninjured)
  Morale: Steady
Bonuses:
  Seamanship & Climb: +3
  Observation & Charts: +4
  Persuasion & Insight: +2
  Stealth & Agility: +3
  Fight & Firearms: +1
Gear:
  - Brass pocket compass and charting charcoal
  - Clasp knife and waxed chart tube
  - Squire’s signed shipboard commission
Allegiance: Free to stand with Smollett and Livesey, play along with Silver to uncover the plot, or strike an independent bargain with Ben Gunn on the island.
`,
  },
  {
    path: "world/characters/smollett.yaml",
    contents: `$document:
  id: character.ti-smollett
  ref: smollett
  title: Captain Smollett
  summary: Disciplined, sharp-eyed captain of the Hispaniola, deeply suspicious of the hand-picked crew.
  aliases: [Captain]
Motive: Keep the ship safe, secure the powder and arms, and bring honest hands home alive; given hard evidence, he will act decisively.
Behavior: Blunt and exacting, yet scrupulously fair and loyal to anyone who does their duty.
Knowledge:
  Knows: Word of the treasure leaked before sailing, almost every sailor was recruited by Silver, and the powder sits too close to the crew’s berths.
  Limits: Has no hard proof of a mutiny plot yet, and has not seen the torn sketch in the hold.
`,
  },
  {
    path: "world/characters/silver.yaml",
    contents: `$document:
  id: character.ti-silver
  ref: silver
  title: Long John Silver
  summary: Charming one-legged ship’s cook beloved by the crew—secretly the veteran pirate leading the mutiny.
  aliases: [Silver, Barbecue]
Motive: Claim Captain Flint’s treasure while keeping his own neck out of the noose; if the tide turns, he will bargain rather than die for stubborn pride.
Behavior: Genial, attentive to younger hands, and quick to test what others know through warm banter; ruthless and swift if cornered.
Knowledge:
  Knows: Most of the crew are old pirate shipmates planning to seize the ship once the treasure is aboard (see @mutiny-roster); he ordered them to stay quiet until sailing.
  Caution: Noticed the player emerging from the hold and uses the warm rum to sound out whether anything was overheard.
`,
  },
  {
    path: "world/characters/livesey.yaml",
    contents: `$document:
  id: character.ti-livesey
  ref: livesey
  title: Dr. Livesey
  summary: Calm, perceptive ship’s doctor and magistrate trusted by both the captain and the squire.
  aliases: [Doctor]
Location: { $ref: location.ti-bristol-quay }
Motive: Keep the honest party alive and prevent the voyage from turning into a slaughter.
Behavior: Steady under fire and pragmatic; if the player reports what happened in the hold, he immediately grasps the stakes.
Knowledge:
  Knows: The true treasure chart remains locked in Squire Trelawney’s inner pocket, out of the crew’s reach.
`,
  },
  {
    path: "world/characters/hands.yaml",
    contents: `$document:
  id: character.ti-hands
  ref: hands
  title: Israel Hands
  summary: Veteran coxswain who plays obedient on deck while serving as one of Silver’s most dangerous confederates.
  aliases: [Hands]
Motive: Hungry for gold and rum, impatient with Silver’s cautious timetable, and prone to slipping when drunk or isolated.
Knowledge:
  Knows: Caught sight of the player near the hold while checking the torn sketch, and wonders whether to test or intimidate the newcomer before dawn.
`,
  },
  {
    path: "world/characters/ben-gunn.yaml",
    contents: `$document:
  id: character.ti-ben-gunn
  ref: ben-gunn
  title: Ben Gunn
  summary: Marooned sailor left on Skeleton Island for three years, knowing every trail and the treasure’s true hiding place.
  aliases: []
Location: { $ref: location.ti-island-shore }
Motive: Desperate for real English cheese, safe passage home, and protection from Silver’s vengeance.
Knowledge:
  Knows: Dug up Flint’s treasure two years ago and moved it piece by piece into a dry cave on the north slope (see @ben-gunn-hoard); also hides a handmade coracle near the shore.
`,
  },
  {
    path: "world/locations/bristol-quay.yaml",
    contents: `$document:
  id: location.ti-bristol-quay
  ref: bristol-quay
  title: Bristol Quay & Hispaniola deck
  summary: Starting hub on the eve of sailing, linking the main deck, aft cabin, and the Spy-glass tavern ashore.
  aliases: []
Layout: The aft cabin houses Smollett, Livesey, and Trelawney; the forward hold stores powder beside the crew hammocks; Silver’s Spy-glass tavern sits at the end of the wharf.
Options: Report the hold encounter to move the powder aft, slip ashore or forward to eavesdrop, or pick up last-minute gear before dawn.
`,
  },
  {
    path: "world/locations/hispaniola-hold.yaml",
    contents: `$document:
  id: location.ti-hold
  ref: hispaniola-hold
  title: Ship’s hold & apple barrel
  summary: Tight quarters at sea, including the half-empty apple barrel by the galley, powder locker, and aft cabin.
  aliases: []
Hiding spot: A deep apple barrel beside the galley lets a quiet listener overhear Silver and his confederates after dark (Stealth check; see @mutiny-roster).
Stakes: Once under sail, control of the powder and arms decides who holds the deck.
`,
  },
  {
    path: "world/locations/island-shore.yaml",
    contents: `$document:
  id: location.ti-island-shore
  ref: island-shore
  title: Skeleton Island shore & pines
  summary: Mist-wrapped anchorage and pine ridges where marooned sailor Ben Gunn watches from cover.
  aliases: []
Terrain: Marshy coves, white sand, freshwater springs, and narrow game trails; pirate shore parties post lookouts along the beach.
Encounter: Exploring the northern pines alone or with a small party can uncover Ben Gunn (@ben-gunn-hoard).
`,
  },
  {
    path: "world/locations/stockade.yaml",
    contents: `$document:
  id: location.ti-stockade
  ref: stockade
  title: Hillside log stockade
  summary: Sturdy timber blockhouse built beside a freshwater spring, commanding the clearing below.
  aliases: []
Defense: Loopholes in thick logs, a spring inside the palisade, and dry firewood; whoever claims it with powder and rations holds the island’s strongest position.
Parley: Silver prefers approaching under a flag of truce to trade terms whenever force looks costly (see @silver-bargain).
`,
  },
  {
    path: "world/locations/spyglass-hill.yaml",
    contents: `$document:
  id: location.ti-spyglass-hill
  ref: spyglass-hill
  title: Spy-glass Hill & empty pit
  summary: High pine ridge marked by the red cross on Flint’s chart, plus the hidden cave on the north slope.
  aliases: []
Site: Beneath the giant pine lies only an empty dug-out pit and a few dropped coins; the real hoard rests inside Ben Gunn’s north-slope cave.
`,
  },
  {
    path: "world/case/voyage-log.yaml",
    contents: `$document:
  id: case.ti-voyage-log
  ref: voyage-log
  title: Voyage & undercurrents log
  summary: Tracks only voyage progress, supplies, and crew movements the player has actually confirmed.
  aliases: []
Voyage & supplies: At anchor (Bristol Quay); fresh water and rations full, powder and arms currently stowed forward.
Noticed signs:
  Hold sketch: Two newly signed hands compared a torn island sketch in the hold and hid it when spotted.
  Captain’s warning: Captain Smollett dislikes the treasure rumors and the forward powder stowage.
Crew stances:
  Captain Smollett: Guarded, waiting for hard proof
  Dr. Livesey: Calm, practical, trustworthy
  Long John Silver: Warm and genial, offering warm rum on deck
`,
  },
  {
    path: "world/archives/mutiny-roster.yaml",
    contents: `$document:
  id: archive.ti-mutiny-roster
  ref: mutiny-roster
  title: Mutiny roster & apple-barrel plot
  summary: Actual crew loyalties aboard the Hispaniola and the pirates’ standing plan.
  aliases: []
Facts:
  Numbers: Out of twenty-six aboard, nineteen—led by Silver and Hands—are old Flint pirates; six are known to remain loyal to the employers (Smollett, Livesey, Trelawney, and three honest hands), while the player’s allegiance is left open to play.
  Plan: Silver wants to wait until the treasure is safely loaded before striking on the return voyage, though hotheads like Hands itch to mutiny sooner.
`,
  },
  {
    path: "world/archives/ben-gunn-hoard.yaml",
    contents: `$document:
  id: archive.ti-ben-gunn-hoard
  ref: ben-gunn-hoard
  title: Ben Gunn’s cave & moved hoard
  summary: Where Flint’s treasure actually rests on Skeleton Island and what Ben Gunn wants.
  aliases: []
Facts:
  Treasure location: Ben Gunn dug up Flint’s hoard two years ago and moved the gold and silver bars into a dry cave on the north ridge.
  Ben Gunn’s price: He longs for English cheese and safe passage home, and is willing to trade the cave’s location and his hidden coracle for them.
`,
  },
  {
    path: "world/archives/silver-bargain.yaml",
    contents: `$document:
  id: archive.ti-silver-bargain
  ref: silver-bargain
  title: Silver’s real terms
  summary: Long John Silver’s true priorities and bargaining line when the tide turns.
  aliases: []
Facts:
  True priorities: Silver has no suicidal loyalty to his crew and fears the English gallows above all.
  Bargaining line: Promised his life and a way out, he is willing to turn against the hotheads and help retake the schooner.
`,
  },
  gameplayFile({ mode: "tabletop", scheme: "d20" }),
  ...storyControlFiles(
    "en",
    "bristol-quay",
    `# Treasure Island: Aboard the Hispaniola (d20 Long-Form Adventure)

Run this as a three-act seafaring sandbox spanning Bristol Quay, the tense crossing, and Skeleton Island. Keep the brisk, vivid edge of classic maritime adventure while letting the player rewrite the story’s course or switch allegiances.

## d20 Resolution & State Tracking

- Narrate ordinary conversation and routine shipboard tasks without rolling. Call for a d20 check only under real risk—eavesdropping from the apple barrel, handling rigging in a squall, pressing a suspicious sailor, holding the stockade, or tracking through island mist—using @protagonist's Bonuses against a clear DC.
- Always fail forward: a missed check alerts a pirate lookout, costs supplies or Vigor, forces a retreat to the stockade, or shifts a wavering sailor toward Silver, never stalling the story.
- Update @protagonist when Vigor, Morale, or Gear changes; update @current-situation and @voyage-log as acts advance or new signs are confirmed.

## On-Demand Reading & Three-Act Flow

- Beyond @bristol-quay, read the other four locations and the three archive dossiers (@mutiny-roster, @ben-gunn-hoard, @silver-bargain) on demand via context_read only when the player reaches or uncovers them—never spoil them early.
- Let the voyage flow naturally from Act I (Eve of sailing) to Act II (Undercurrents at sea) and Act III (Skeleton Island), pausing at every major tactical or faction fork for the player’s decision.
`,
    ["voyage-log"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "sailor-sheet",
          title: "Chartmaker",
          items: [
            {
              id: "vitality-morale",
              label: "Condition",
              document: "protagonist",
              locator: ["Condition"],
            },
            {
              id: "bonuses",
              label: "Bonuses (d20)",
              document: "protagonist",
              locator: ["Bonuses"],
            },
            {
              id: "gear",
              label: "Gear",
              document: "protagonist",
              locator: ["Gear"],
            },
          ],
        },
        {
          id: "voyage-board",
          title: "Voyage & undercurrents",
          items: [
            {
              id: "supply-stage",
              label: "Voyage & supplies",
              document: "voyage-log",
              locator: ["Voyage & supplies"],
            },
            {
              id: "noticed-signs",
              label: "Noticed signs",
              document: "voyage-log",
              locator: ["Noticed signs"],
            },
            {
              id: "crew-stances",
              label: "Crew stances",
              document: "voyage-log",
              locator: ["Crew stances"],
            },
          ],
        },
      ],
    },
  ),
];
