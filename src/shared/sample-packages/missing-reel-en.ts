import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const missingReelEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `On the far wall of the Tidehouse Sound Archive, a photograph shows forty dockworkers trying to sing above a foghorn. At six, if all goes to plan, their voices will play in this room for the first time in thirty years.

The display case is open. In the middle of its blue felt is a clean circle, the size of a dinner plate.

“The master was there at twenty past,” says Mara, the archivist. She makes room for you on her side of the case. You helped catalogue the recordings last winter. She remembers that you put down what people said, even when you thought they were wrong.

Noel, the volunteer at the door, is holding a grey canvas sleeve. “I was going to wrap it in this. I can tell you who signed in.”

Viv, the technician, folds a yellow work slip so the written side is inside. A flight case clicks shut behind her. “The rehearsal file still plays. We could open the doors on time.”

Through the glass doors, the first guest tries the handle and lifts a paper invitation in apology. Mara puts the exhibit key on the felt, just outside the circle.

“Will you help me establish what actually happened?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.missing-reel
  ref: current-situation
  title: The circle in the felt
  summary: A master reel is missing half an hour before the listening party.
  aliases: []
background:
  Time: Saturday, 5:32 p.m.
  Place: Tidehouse Sound Archive, exhibition room
Present:
  - { $ref: character.mara-vale }
  - { $ref: character.noel-park }
  - { $ref: character.viv-santos }
  - { $ref: character.player }
Awaiting a response:
  Speaker: { $ref: character.mara-vale }
  Words: Will you help me establish what actually happened?
  Position: Mara has just set the exhibit key beside the empty space in the case.
Immediate choices:
  - Noel offers to account for the sign-ins and still holds the canvas sleeve.
  - Viv proposes using the rehearsal file to open on time.
  - The first guest is outside the locked public doors. The player can also help with the event even if they leave the search to Mara.
`,
  },
  {
    path: "world/characters/player.yaml",
    contents: `$document:
  id: character.player
  ref: protagonist
  title: The player character
  summary: The player controls this former cataloguing volunteer at Tidehouse Sound Archive.
  aliases: []
Connection: Helped catalogue recordings last winter. Mara trusts the player's habit of separating what a person says from what can be checked.
Authority: Here as a guest. May ask Mara for access or for help preserving material. No official authority over people or private belongings.
`,
  },
  {
    path: "world/characters/mara.yaml",
    contents: `$document:
  id: character.mara-vale
  ref: mara
  title: Mara Vale
  summary: Archivist and event organizer. She was responsible for the reel.
  aliases: []
Motive: Wants the singers and their families to hear the whole recording. She will delay the program if she has a concrete reason to give the waiting families.
Behavior: Speaks in measured times and dates when anxious. Answers direct questions about the key or the paperwork.
Knowledge:
  Saw: She checked the brass hub at 5:20 p.m. and left the glass case on the courtesy latch for the scheduled microphone test.
  Assumes: Suspects an innocent move during setup. She has not heard the rehearsal file from start to finish.
  Access: Her exhibit key opens the case when locked. The courtesy latch could be lifted without a key during setup.
`,
  },
  {
    path: "world/characters/noel.yaml",
    contents: `$document:
  id: character.noel-park
  ref: noel
  title: Noel Park
  summary: Door volunteer keeping the sign-in sheet and the assigned storage sleeve.
  aliases: []
Motive: Wants to earn a paid archive placement and fears Mara will mistake one unlogged errand for carelessness.
Behavior: Starts with the sign-in sheet. When asked what he personally saw, he can give the corridor account and admit he held the door off book.
Knowledge:
  Saw: While carrying paper cups from the tea counter, he held the service corridor door for Viv at about 5:28 p.m. She carried a shallow grey calibration case flat in both hands.
  Believes: Thought the case contained a test weight. The canvas sleeve in his own hands was fetched from a cupboard and has never held the reel today.
  Limits: He did not see inside the exhibition case after Mara checked it. The public sign-in sheet records visitors rather than staff movements.
`,
  },
  {
    path: "world/characters/viv.yaml",
    contents: `$document:
  id: character.viv-santos
  ref: viv
  title: Viv Santos
  summary: Sound technician responsible for rehearsal playback and gear checkout.
  aliases: []
Motive: Her grandmother Ada sings the first verse and introduces the dockworkers by name on the master. Viv wants the archive to restore those credits before the donor's copy leaves the building.
Behavior: Efficient in public, defensive when accused before anyone checks the record. A private approach grounded in the missing introduction can get her to open the case willingly.
Knowledge:
  Action: Moved the master to the calibration case. Knows exactly where she put it.
  Evidence: Knows the shorter rehearsal file omits Ada's introduction. Has a yellow duplicate of her equipment slip in hand.
  Assumption: Thinks Mara knowingly approved the donor's edited version. She has not seen which sheet Mara actually signed.
`,
  },
  {
    path: "world/locations/exhibition-room.yaml",
    contents: `$document:
  id: location.tidehouse-exhibition
  ref: exhibition-room
  title: Tidehouse exhibition room
  summary: The display and listening space. The service corridor runs behind its partition.
  aliases: []
Access: The public doors open at six unless Mara changes the plan. Staff and guests accompanied by Mara can reach the service corridor.
Display: A hinged case with blue felt and a courtesy latch. A clean circle marks the reel's old position. Raking light across the rear hinge reveals a single loose orange cotton fiber caught there.
Listening station: A public headset plays the rehearsal file. A printed cue sheet beside the display marks the first track as a spoken roll call followed by the first verse. Playing the file reveals it starts on the second verse.
Use after tonight: The room hosts open listening hours and neighborhood recording appointments.
`,
  },
  {
    path: "world/locations/service-corridor.yaml",
    contents: `$document:
  id: location.tidehouse-corridor
  ref: service-corridor
  title: Service corridor
  summary: The checkout shelf, loading door, and bench where technicians prepare the sound gear.
  aliases: []
Gear: Bay C holds a closed shallow grey calibration case, tagged with an orange cotton pull. Its cord has a fresh frayed end. A witness can distinguish it from the tall black flight case in the exhibition room.
Records: The checkout board holds the white originals of numbered slips. Ticket 041 is signed by Viv at 5:26 p.m. for the grey case; the adjacent inventory says the case's usual calibration disc was lent out that morning. Mara can escort a visitor here.
Schedule: The contractor collecting idle gear is due at 5:50 p.m. Mara can hold the pickup if asked before the case leaves.
Use after tonight: Staff check in loan gear and post work and collection notices here.
`,
  },
  {
    path: "world/locations/reading-room.yaml",
    contents: `$document:
  id: location.tidehouse-reading-room
  ref: reading-room
  title: Tidehouse reading room
  summary: Public reading tables where staff keep cue sheets, approvals, and recording credits.
  aliases: []
Access: The desk copy of event paperwork can be consulted by any visitor during the event or with Mara before opening.
Records: The original cue sheet names Ada Santos in the roll call. Mara signed approval for the full-length playback, with the spoken credits included. A separate donor proof calls the short cut “final” but has no archive signature.
Daily life: Visitors listen to digitized recordings, help transcribe names, and can arrange to record their own interviews.
`,
  },
  {
    path: "world/case/public-notes.yaml",
    contents: `$document:
  id: case.missing-reel-notes
  ref: case-notes
  title: Case notes
  summary: Observations already shared with the player, kept separate from theories.
  aliases: []
Known clues:
  Empty case: Mara says she saw the master at 5:20 p.m. The player can see its empty place on the blue felt.
`,
  },
  {
    path: "world/case/custody.yaml",
    contents: `$document:
  id: case.reel-custody
  ref: reel-custody
  title: Master reel custody
  summary: Host's record of the reel's location and movements.
  aliases: []
Object: The sole full-length original has a brass hub stamped TS-017. The short digital rehearsal file is a separate object.
Location at opening: In a clean paper sleeve inside the grey calibration case in Bay C of the service corridor. The original is undamaged.
Established events:
  - At 5:20 p.m. Mara saw the reel in the exhibit and left the courtesy latch available for the microphone test.
  - At 5:26 p.m. Viv checked out the empty grey case. She took the reel from the exhibit at 5:27 p.m. and put it in the case, catching the case's cotton tag in the display hinge. At 5:28 p.m. Noel held the corridor door while she returned the case to Bay C.
  - Viv acted to stop the full master leaving under the donor's shortened credits and meant to retrieve it after speaking privately to Mara. Nobody else moved the reel.
Verification:
  Physical: The fiber and the frayed tag point to the case. Opening it with staff cooperation exposes the stamped hub.
  Records: The checkout slip and inventory independently establish who took the empty case and when. The cue sheet, audio, and two proofs establish the credit dispute.
  Witness: Noel can trace who carried the case toward Bay C. Viv can admit her action, with inspection of the hub still available to corroborate it.
`,
  },
  ...storyControlFiles(
    "en",
    "exhibition-room",
    `# The missing master

Use the custody record as the established past. Let the player discover it by examining the exhibit, listening, comparing records, speaking to people, or another justified route. A detail in a host document is not something the player or another person automatically knows. Describe evidence when the player has access. A witness can give an incomplete but honest account. The reel and the short playback file have different contents and uses.

Keep @case-notes#/Known clues limited to observations or attributed statements actually shared with the player. Once found, the reel's custody belongs in @reel-custody. Advance the current situation as people make decisions. If the collection actually occurs, record where the case went so pursuit remains possible. Let the player decide whom to tell and whether to negotiate credit, preserve evidence, run the listening party, or leave the investigation. A correct account can be pieced together without a confession. There is room for further archive work after this case.
`,
    ["case-notes", "reel-custody"],
    { document: "case-notes", key: "Known clues" },
  ),
];
