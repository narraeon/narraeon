import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const treasureIslandEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `Sea fog clings to Bristol Quay, thick with tar and salt. The schooner Hispaniola creaks gently on the rising tide, deck lanterns stretching the sailors’ shadows across the planks. At first light, she sails for the South Atlantic in search of an island marked only on an old chart.

Dr. Livesey and Squire Trelawney hired you as the expedition’s junior chartmaker. You had just checked that the ship had its full stores of fresh water and rations when you caught two newly signed hands at the hold hatch, quietly poring over a single island sketch with a corner torn off. The moment they saw you, they pocketed the sketch and laughed it off as southern star bearings.

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
  title: Current situation aboard the Hispaniola
  summary: Records the current voyage act, time, place, people present, and the player’s next decision.
  aliases: []
background:
  Time: Night 1, eve of sailing (Bristol Quay)
  Place: Main deck of the Hispaniola and Bristol jetty
  Voyage act: Act I — Eve of sailing
Present:
  - { $ref: character.ti-protagonist }
  - { $ref: character.ti-smollett }
  - { $ref: character.ti-silver }
Pending decision:
  Choice: Will the chartmaker speak privately with Captain Smollett and the doctor first, or talk with Silver and the sailors on deck?
  Scene: The captain has left the drink untouched. Silver still stands a few paces away with the warm rum.
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
Allegiance: The player decides as the voyage unfolds.
`,
  },
  {
    path: "world/characters/smollett.yaml",
    contents: `$document:
  id: character.ti-smollett
  ref: smollett
  title: Captain Smollett
  summary: Captain in command of the Hispaniola.
  aliases: [Captain]
Motive: Keep the ship safe, secure the powder and arms, and bring honest hands home alive; given hard evidence, he will act decisively.
Behavior: Blunt and exacting, yet scrupulously fair and loyal to anyone who does their duty.
Knowledge:
  Knows: Word of the treasure leaked before sailing, almost every sailor was recruited by Silver, and the powder sits too close to the crew’s berths.
  Limits: Has no hard proof of a mutiny plot yet, and does not know about the island sketch with a corner torn off at the hold hatch.
`,
  },
  {
    path: "world/characters/silver.yaml",
    contents: `$document:
  id: character.ti-silver
  ref: silver
  title: Long John Silver
  summary: One-legged cook aboard the Hispaniola who walks with a crutch.
  aliases: [Silver]
Motive: Claim Captain Flint’s treasure while keeping his own neck out of the noose; if the tide turns, he will bargain rather than die for stubborn pride.
Behavior: Genial, attentive to younger hands, and quick to test what others know through warm banter; ruthless and swift if cornered.
Knowledge:
  Knows: Most of the crew are old pirate shipmates planning to seize the ship once the treasure is aboard (see @ship-roster); he ordered them to stay quiet until sailing.
  Caution: Noticed the player emerging from the hold and uses the warm rum to sound out whether anything was overheard.
`,
  },
  {
    path: "world/characters/livesey.yaml",
    contents: `$document:
  id: character.ti-livesey
  ref: livesey
  title: Dr. Livesey
  summary: The ship’s doctor, who hired the chartmaker with Squire Trelawney.
  aliases: [Doctor]
Location: { $ref: location.ti-bristol-quay }
Other office: Magistrate.
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
  summary: Experienced coxswain aboard the Hispaniola.
  aliases: [Hands]
Allegiance: Plays obedient on deck and is one of Silver’s most dangerous confederates.
Motive: Hungry for gold and rum, impatient with Silver’s cautious timetable, and prone to slipping when drunk or isolated.
Knowledge:
  Knows: Saw the player approach while he and a confederate were poring over the island sketch with a corner torn off at the hold hatch, and wonders whether to test or intimidate the newcomer before dawn.
`,
  },
  {
    path: "world/characters/ben-gunn.yaml",
    contents: `$document:
  id: character.ti-ben-gunn
  ref: ben-gunn
  title: Ben Gunn
  summary: A sailor.
  aliases: []
Location: { $ref: location.ti-island-shore }
Background: Marooned on Skeleton Island by his former pirate shipmates three years ago. He knows every trail on the island.
Motive: Desperate for real English cheese, safe passage home, and protection from Silver’s vengeance.
Knowledge:
  Knows: Dug up Flint’s treasure two years ago and moved it piece by piece into a dry cave on the north slope (see @island-notes); also hides a handmade coracle near the shore.
`,
  },
  {
    path: "world/locations/bristol-quay.yaml",
    contents: `$document:
  id: location.ti-bristol-quay
  ref: bristol-quay
  title: Bristol Quay & Hispaniola deck
  summary: Bristol’s jetty, moored ships, and the Spy-glass tavern.
  aliases: []
Layout: The aft cabin houses Smollett, Livesey, and Trelawney; the forward hold is beside the crew hammocks; Silver’s Spy-glass tavern sits at the end of the wharf.
Options: Report the hold encounter to move the powder aft, slip ashore or forward to eavesdrop, or pick up last-minute gear before dawn.
`,
  },
  {
    path: "world/locations/hispaniola-hold.yaml",
    contents: `$document:
  id: location.ti-hold
  ref: hispaniola-hold
  title: Quarters aboard the Hispaniola
  summary: The galley, hold, and aft cabin of the Hispaniola.
  aliases: []
Hiding spot: A deep apple barrel beside the galley lets a quiet listener overhear Silver and his confederates after dark (Stealth check; see @ship-roster).
Stakes: Once under sail, control of the powder and arms decides who holds the deck.
`,
  },
  {
    path: "world/locations/island-shore.yaml",
    contents: `$document:
  id: location.ti-island-shore
  ref: island-shore
  title: Skeleton Island shore & pines
  summary: The coves, white sand, and coastal pines of Skeleton Island.
  aliases: []
Terrain: Marshy coves, white sand, freshwater springs, and narrow game trails; pirate shore parties post lookouts along the beach.
Encounter: Exploring the northern pines alone or with a small party can uncover Ben Gunn (@island-notes).
`,
  },
  {
    path: "world/locations/stockade.yaml",
    contents: `$document:
  id: location.ti-stockade
  ref: stockade
  title: Hillside log stockade
  summary: A log stockade and clearing on a hillside of Skeleton Island.
  aliases: []
Defense: Loopholes in thick logs, a spring inside the palisade, and dry firewood; whoever claims it with powder and rations holds the island’s strongest position.
Parley: Silver prefers approaching under a flag of truce to trade terms whenever force looks costly (see @parley-notes).
`,
  },
  {
    path: "world/locations/spyglass-hill.yaml",
    contents: `$document:
  id: location.ti-spyglass-hill
  ref: spyglass-hill
  title: Spy-glass Hill
  summary: A high pine-covered ridge on Skeleton Island.
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
  summary: Tracks the supplies, arms, unusual signs, and people known to the player.
  aliases: []
Supplies & arms:
  Fresh water and rations: At the hold hatch, the chartmaker checked that both were fully stocked
  Arms and powder: The captain says they are stowed forward, next to the crew’s hammocks
Noticed signs:
  Hold sketch: Two newly signed hands quietly studied one island sketch with a corner torn off at the hold hatch. They hid it as the chartmaker approached and claimed they were checking southern star bearings.
  Captain’s warning: Captain Smollett says word of the treasure seems to have reached the whole crew and worries how close the arms are to the hammocks.
Shipmates:
  Captain Smollett: Stopped the chartmaker on the main deck and suggested a private talk with him and the doctor
  Dr. Livesey: Hired the chartmaker with Squire Trelawney
  Long John Silver: The ship’s cook, who brought warm rum onto the main deck
`,
  },
  {
    path: "world/archives/ship-roster.yaml",
    contents: `$document:
  id: archive.ti-mutiny-roster
  ref: ship-roster
  title: Hispaniola crew records
  summary: Reference notes on the people aboard the Hispaniola and arrangements for the voyage.
  aliases: []
Facts:
  Numbers: Out of twenty-six aboard, nineteen—led by Silver and Hands—are old Flint pirates; six are known to remain loyal to the employers (Smollett, Livesey, Trelawney, and three honest hands), while the player’s allegiance is left open to play.
  Plan: Silver wants to wait until the treasure is safely loaded before striking on the return voyage, though hotheads like Hands itch to mutiny sooner.
`,
  },
  {
    path: "world/archives/island-notes.yaml",
    contents: `$document:
  id: archive.ti-ben-gunn-hoard
  ref: island-notes
  title: Skeleton Island notes
  summary: Reference notes on past and present conditions on Skeleton Island.
  aliases: []
Facts:
  Treasure location: Ben Gunn dug up Flint’s hoard two years ago and moved the gold and silver bars into a dry cave on the north ridge.
  Ben Gunn’s price: He longs for English cheese and safe passage home, and is willing to trade the cave’s location and his hidden coracle for them.
`,
  },
  {
    path: "world/archives/parley-notes.yaml",
    contents: `$document:
  id: archive.ti-silver-bargain
  ref: parley-notes
  title: Parley notes
  summary: Reference notes for negotiations that may come up on the voyage.
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
- Update @protagonist when Vigor, Morale, or Gear changes. Update the body of @current-situation when the time, place, people present, or pending decision changes, and keep its title and summary stable. On changing acts, update the voyage act only at background / Voyage act in @current-situation.
- Use @voyage-log for the supplies and arms, unusual signs, and people known to the player. Attribute observations and testimony to their sources and update the relevant entries as the player learns more.

## On-Demand Reading & Three-Act Flow

- Beyond @bristol-quay, read the other four locations and the three archives (@ship-roster, @island-notes, @parley-notes) on demand via context_read. Reveal details as the player encounters or uncovers them.
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
              id: "voyage-act",
              label: "Voyage act",
              document: "current-situation",
              locator: ["background", "Voyage act"],
            },
            {
              id: "supplies-arms",
              label: "Supplies & arms",
              document: "voyage-log",
              locator: ["Supplies & arms"],
            },
            {
              id: "noticed-signs",
              label: "Noticed signs",
              document: "voyage-log",
              locator: ["Noticed signs"],
            },
            {
              id: "shipmates",
              label: "Shipmates",
              document: "voyage-log",
              locator: ["Shipmates"],
            },
          ],
        },
      ],
    },
  ),
];
