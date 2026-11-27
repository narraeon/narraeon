import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const tideVaultEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `At low tide, the sea gives back six steps that the people of Alder Head carved before they had a quay. On the sixth, you pass under the arch with your two companions. Above your heads, tiny shells gleam where the water stood this morning.

You are leading this descent into the drowned vault. A thumb-long bronze bird is set into the wall by the entrance. Below it, two shallow arrows point in different directions: one travels level into a tiled gallery; the other climbs toward a narrow seam. A pale bird-shaped light hovers close to the bronze, its wings half open.

Ivo braces his tide staff on the bottom step. “About thirty-five minutes before we lose this arch. That upper mark might be a way back, if the line of holes really does go through.” He lifts his lamp. A row of square holes follows the climbing arrow.

Sera kneels at the gallery mouth. From beyond the tiles come two knocks, a pause, then one more. Sera taps back with her ring. “Ren did that through the wall when we worked on the seawall. It could be him.” She takes one hand off the rope at her shoulder and opens it toward you.

“Can we spare a little time to find who’s knocking?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.tide-vault
  ref: current-situation
  title: The bronze bird at low water
  summary: The party has entered the vault and heard a signal from farther inside.
  aliases: []
background:
  Time: 4:20 p.m., low water
  Place: Under the shore arch at Alder Head
Present:
  - { $ref: character.vault-leader }
  - { $ref: character.tide-ivo }
  - { $ref: character.tide-sera }
Expedition status:
  Tide window: Low water; about 35 minutes left to walk out under the arch (bird-light hovering)
  Rope location: Coiled on Sera's shoulder (24 m, not yet rigged)
  Confirmed leads:
    Knocking: Two knocks, a pause, and one more from inside the gallery; Sera recognizes Ren's habit, not yet seen.
    Upper seam: Lamp light shows square footholds climbing past the first lip; far end unverified.
Awaiting a response:
  Speaker: { $ref: character.tide-sera }
  Words: Can we spare a little time to find who’s knocking?
  Action: Sera still has the coil on one shoulder. She has made a return signal with her ring and is waiting at the gallery mouth.
Positions:
  - Ivo and his lamp are at the bottom step beside the tide staff.
  - The party has heard the rhythm and seen both arrows and the pale bird-light above the bronze. Nobody in the party has seen who made the noise.
`,
  },
  {
    path: "world/characters/leader.yaml",
    contents: `$document:
  id: character.vault-leader
  ref: protagonist
  title: The expedition leader
  summary: The player leads the small party. Their name, history, and reasons for coming are open.
  aliases: []
Authority: Sets direction with the companions and can propose splitting, turning back, or changing the purpose of the descent. The companions decide how much danger they will accept.
Agreed before departure: Each person may call for a stop. If they separate, they leave a lamp at the last junction they agree to meet at.
`,
  },
  {
    path: "world/characters/ivo.yaml",
    contents: `$document:
  id: character.tide-ivo
  ref: ivo
  title: Ivo
  summary: Alder Head’s tide reader and the expedition’s surveyor.
  aliases: []
Goal: Wants to see where the old sluice feeds the lower orchard. Salt has reached two of the village wells this season. A sketch of the channels could help his neighbors decide where to dig.
Gear: Hooded lamp, tide staff, slate and chalk.
Knowledge: He knows the shore arch’s usual water marks from outside. The upper arrow and holes remind him of the old masons’ footholds. He has never reached their far end and cannot vouch for the exit. He has also heard of a long-sealed inspection door behind the old orchard cistern in the village.
Position on risk: Will stop for a credible rescue. Wants the group to check actual water signs before committing to the gallery, and can do so or stay to mark the way if asked.
`,
  },
  {
    path: "world/characters/sera.yaml",
    contents: `$document:
  id: character.tide-sera
  ref: sera
  title: Sera
  summary: Seawall mason with rope skills. She recognized the rhythm of the knocks.
  aliases: []
Goal: Wants to find her former apprentice Ren, who borrowed tools yesterday and did not report in this morning. Ren had asked her about the lowest arch last week.
Gear: One sound twenty-four-meter rope, two iron rings, a stub of tallow candle. She can rig a handline if she can inspect a sound fixing.
Knowledge: The rhythm was Ren’s way of asking whether someone could hear him across a wall. Someone else could make the same sounds. She cannot see their source from the entrance.
Position on risk: Will spare mapping time for a rescue and listen to a workable retreat plan. She wants a shore marker left if the party cannot investigate yet.
`,
  },
  {
    path: "world/characters/ren.yaml",
    contents: `$document:
  id: character.tide-ren
  ref: ren
  title: Ren
  summary: Mason who borrowed an inspection hammer and has been away since yesterday.
  aliases: []
Location: { $ref: location.vault-bell-gallery }
Position: On the dry service ledge beyond the broken footbridge. A settling step bruised his ankle before this ebb. He can put some weight on it and help lash a line but cannot jump the bridge gap.
Framing his own errand: He expected to mark the collapsing masonry for the village, then check one sealed inspection bay he remembers from an old drawing.
Carrying: Sera's borrowed inspection hammer, a stub of chalk, and a mason's field notebook tucked in his tool roll (see @ren-field-notes).
Knows: He has seen a wall-bracket at his end of the ledge. He knows the return under the arch is temporary from past shore work. He has not climbed the upper traverse.
Current action: Made the knocks with the inspection hammer and is listening for a return. Voice carries poorly around the first corner above the wash at the base of the gallery.
`,
  },
  {
    path: "world/locations/shore-arch.yaml",
    contents: `$document:
  id: location.vault-shore-arch
  ref: shore-arch
  title: Alder Head shore arch
  summary: The tidal entrance. Two cut arrows offer visibly different routes.
  aliases: []
Terrain: Six wet steps climb from the shore to a dry stone threshold at low water. The bronze bird once marked the entrance to the vault’s sluice works. Its pale ward-light hovers above it at low water. As the tide reaches the dark notch, the light takes wing and follows the level channel as far as the first turn. Sluice keepers used to call this the bird coming off its perch.
Visible routes:
  Level arrow: Leads into the tiled passage toward the bell gallery. From the arch one cannot see beyond its first turn.
  Rising arrow: Points up a seam with square foothold holes. The stone is slippery near the bottom; some of the holes retain iron sockets. Casting light up the wall shows that the row does continue above the first lip.
Tide estimate:
  - Outward under the shore arch is normally walkable for about thirty-five minutes from this low water. When the dark notch below the bronze bird vanishes, about ten minutes remain at ordinary rise.
  - When water touches the bird’s foot, the narrow return under the arch is no longer a safe walking route. Swell can take it earlier. At this level the water can be read by looking back from the passage or by leaving someone at the staff.
Shore: A gravel landing is safe above the steps. A fishing crew keeps a lamp in the boathouse within shouting distance of that landing.
`,
  },
  {
    path: "world/locations/bell-gallery.yaml",
    contents: `$document:
  id: location.vault-bell-gallery
  ref: bell-gallery
  title: Bell gallery
  summary: A broken bridge, a raised service ledge, and the old sluice library.
  aliases: []
Approach: About five minutes from the arch at a careful walk. The tide presses up through the broken floor as the channel fills.
Crossing: A two-meter gap in the old plank bridge separates the passage from the service ledge. Both sides have stone rings mortared deep into the wall. Solid masonry sounds dull under a tap; the loose bridge-end slab rings bright and shifts under load.
High connection: A set of rungs from the service ledge leads into the upper traverse. The middle rung has dropped out; the old rung sockets can be reached with a light and rigging.
Work to return for: Beyond the ledge, older clay tablets show separate fresh-water and salt-water channels. A ceramic yard seal on the lowest shelf matches marks on the village’s sealed inspection doors, and a dry recess behind the rack holds an older sluice secret (see @sluice-seal-ledger). Reading the tablets here takes time. A rubbing or quick sketch is possible before the lowest shelf gets wet.
`,
  },
  {
    path: "world/locations/upper-traverse.yaml",
    contents: `$document:
  id: location.vault-upper-traverse
  ref: upper-traverse
  title: Upper traverse
  summary: A narrow high route linking the shore seam, the gallery, and a service shutter.
  aliases: []
Approach from shore arch: Allow about twelve minutes from the arch to the high junction with a lamp and a careful rig. An unguarded slip at the lower seam drops onto wet stone.
At the junction: One branch descends to the bell gallery rungs. The other bends toward a headland shutter. A stream of cool dry air from the shutter branch is strongest with a lamp held flat to the wall.
Shutter: The stone shutter is dry above an ordinary high tide. Its small keeper pin has seized. From the inside the pin can be moved with a short lever if mud is cleared from the socket. It opens onto a ledge with steps to the sheep path. Ivo cannot know this firsthand before somebody inspects it.
Constraints: A climbing line used here may be left in place or recovered at the cost of time. Whoever carries it can use it elsewhere; the same rope cannot serve both routes at once.
`,
  },
  {
    path: "world/archives/sluice-seal-ledger.yaml",
    contents: `$document:
  id: archive.tide-vault-sluice-ledger
  ref: sluice-seal-ledger
  title: Sluice yard seal and village brine ledger
  summary: Old sluice records and physical fittings hidden in the bell gallery's clay tablets and dry recess.
  aliases: []
Location: The clay tablet rack and the dry recess behind its lowest shelf on the bell gallery ledge.
Physical clues and records:
  Dry recess and bronze valve key: Behind the lowest tablet shelf sits a loose brick stamped with the same bird-and-wave mark as the entrance bronze, concealing a salt-crusted bronze valve key and a half-slate inscription.
  What the tablets show: Fifty years ago, a storm cracked the freshwater weir stone; rather than repair the deep sluice, someone hastily plugged the wrong bypass gate from the village orchard cistern, gradually forcing brine into the lower well veins.
  Hydraulic risk: Opening the sealed village inspection door with the valve key relieves brine pressure on the wells, but unless the cracked weir below the bell gallery is braced at low water first, a spring tide will flood two lower orchard cellars.
`,
  },
  {
    path: "world/archives/ren-field-notes.yaml",
    contents: `$document:
  id: archive.tide-vault-ren-notes
  ref: ren-field-notes
  title: Ren's mason notebook
  summary: Field notebook in Ren's tool roll recording fresh mortar and bridge-plank observations.
  aliases: []
Location: Tucked inside Ren's tool roll.
Notes:
  Fresh mortar and chisel marks: Near the sealed inspection bay, Ren found unweathered mortar slapped over the old warning carving about the misplugged bypass gate during a recent ebb tide.
  Bridge suspicion: Ren suspects the wedging block under the loose bridge plank may have been pried out, though he fell before he could tell rot from tampering.
  Mortar makeup: The fresh mortar contains fine red brick dust fired only at the lower orchard kiln.
`,
  },
  ...storyControlFiles(
    "en",
    "shore-arch",
    `# At the drowned sluice works

Run this as an exploration in real choices of route, time, gear, and trust. Let care or a well-aimed question reveal a physical observation. Give companions a chance to offer help, name a risk, or refuse an unsafe order. Sera’s recognition gives a lead; let a sound, a view, or contact with Ren confirm the source. Ivo’s village errand and Sera’s rescue both remain worth pursuing after this descent.

Let the wall marks, rising water, and time spent agree with one another. Give the party signs before the shore arch is cut off. Verify the upper exit by what the party can observe, and allow aid from shore, a revised plan, or a return at the next ebb. Track the rope with its actual holder or fixing and durable outcomes in the documents they affect. Update the current situation with elapsed time, whoever is present, and Expedition status (Tide window, Rope location, Confirmed leads) as the party acts—never write unseen secrets into Confirmed leads early.

@sluice-seal-ledger and @ren-field-notes are second-layer hidden clues: read them on demand via context_read only when the party inspects the bell gallery tablets or recess, reaches Ren, or examines the mortar and chalk marks—never reveal them at the entrance. The player may explore, help, investigate the sluice mystery, or retreat empty-handed. Stop for the player’s choice instead of spending a whole tide in one reply.
`,
    [],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "expedition-status",
          title: "Expedition status",
          items: [
            {
              id: "tide-window",
              label: "Tide window",
              document: "current-situation",
              locator: ["Expedition status", "Tide window"],
            },
            {
              id: "rope-location",
              label: "Rope location",
              document: "current-situation",
              locator: ["Expedition status", "Rope location"],
            },
            {
              id: "found-leads",
              label: "Confirmed leads",
              document: "current-situation",
              locator: ["Expedition status", "Confirmed leads"],
            },
          ],
        },
      ],
    },
  ),
];
