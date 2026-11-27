import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const lastProofEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `The bell at the corner print shop has been taken down. It lies on the counter with a square of pale paint stuck to its bracket. You push the door anyway. June, the owner, lifts a finger without looking up from her packing tape. “Still open for forty-five minutes.”

Lin from the floor below is standing over a drying rack. Until now you've mostly known them by their handwriting. Once they left a note so polite about your laundry that you didn't realize until the second reading they were asking you to take it out of the machine.

They lift a test print by two corners. It's a blue drawing of your building, right down to the window that never quite closes on the landing. The rectangle at the bottom is blank.

“I was going to write *For the people who live here*.” Lin shows you the pencil marks. “June asked me what I'd put if I knew the people would read it.”

The press ticks as it cools. From the noodle shop next door comes the hiss of a sieve tipped into water. You brought the hallway key to check the list of names, and it's still in your coat pocket.

Lin moves the second stool into the light. “Would you stay for one more proof? We can get noodles after, if you feel like it.”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.last-print
  ref: current-situation
  title: Two stools by the drying rack
  summary: A neighbor asks for help with a print before the street-corner shop closes for its move.
  aliases: []
background:
  Time: Friday, 8:15 p.m.
  Place: Larch Street Printshop
Present:
  - { $ref: character.lin-zhao }
  - { $ref: character.june-price }
  - { $ref: character.player }
Awaiting a response:
  Speaker: { $ref: character.lin-zhao }
  Words: Would you stay for one more proof? We can get noodles after, if you feel like it.
  Position: Lin has pulled up a stool. The two invitations are open and can be answered separately.
Immediate circumstances:
  - June will switch off the old press at nine. The move begins tomorrow at eight.
  - A blue drawing of the building is on the rack. The space for a line of type stays blank.
  - The hallway key is in the player's pocket. The shop and print are open to a quick practical visit or a longer conversation.
`,
  },
  {
    path: "world/characters/player.yaml",
    contents: `$document:
  id: character.player
  ref: protagonist
  title: The player character
  summary: The player controls an adult tenant of Number 19 on Larch Street.
  aliases: []
Age: 29 by default. The protagonist and romantic interests are adults.
Connection: Lives a floor above Lin. Has exchanged neighborly notes and held the door for them. Agreed to bring the hallway key to check names for the print.
Decisions: The player has given no commitment to stay, eat together, date anyone, or leave a signed contribution.
`,
  },
  {
    path: "world/characters/lin.yaml",
    contents: `$document:
  id: character.lin-zhao
  ref: lin
  title: Lin Zhao
  summary: An adult neighbor downstairs who drew Number 19 and set up the print run.
  aliases: []
Age: 31
Pronouns: They and them
Life: Draws building elevations for a living. Takes an evening train three days a week and tends to eat noodles late on Fridays.
Temporary evening work:
  Role: Recently accepted a temporary evening shift.
  Location: Across town.
  Duration: One month.
Motive: Wants the tenants to recognize their building in the print. Would like to know the player better. For now sharing work or a table is enough, and either invitation can be declined freely.
Manner: Good with precise tasks, shy about leaving a question open. Laughs when dry ink lands on their knuckle. May make an invitation explicit in private if the player makes a reciprocal opening.
Knowledge:
  print: Has permission to print Noor's name and their own. Does not know which other neighbors have agreed.
  move: Knows June's shop is moving. Remains a tenant of Number 19.
  Evening work shared with the player:
    Role: Not yet disclosed.
    Location: Not yet disclosed.
    Duration: Not yet disclosed.
  player: Recognizes the player's handwriting from the laundry note exchange and has no basis to assume attraction or a relationship.
`,
  },
  {
    path: "world/characters/june.yaml",
    contents: `$document:
  id: character.june-price
  ref: june
  title: June Price
  summary: Owner of Larch Street Printshop, supervising its last evening in this room.
  aliases: []
Age: 58
Motive: Wants the press and type to travel safely and the shop's work to continue. Is sentimental about the old room and shows it by carefully wrapping mundane objects.
Manner: Will save a clean sleeve for a finished copy. At nine she holds her deadline and can offer tomorrow's paid move shift or next week's open workshop in the new shop.
Knowledge:
  press: One proof and a small run are possible if the line is settled quickly. Once the press is switched off, finishing in the old room is off the table.
  neighbor: Knows Noor agreed to a name on the print. Is ready to suggest a dedication without names if permissions remain unsettled.
  relationship: Knows Lin has been looking forward to showing the player the print. Has heard nothing about a date.
`,
  },
  {
    path: "world/characters/noor.yaml",
    contents: `$document:
  id: character.noor-haddad
  ref: noor
  title: Noor Haddad
  summary: Adult tenant and keeper of the building notice board. She is upstairs at Number 19.
  aliases: []
Age: 36
Motive: Wants a copy for the notice board and names for only the people who volunteer them. She has a night shift coming up and prefers brief messages.
Manner: Keeps an old tea tin of spare noticeboard pins. Will read a proof or send a photo of the permission list if asked before 8:40 p.m.
Knowledge:
  permissions: Noor and Lin said yes. The fourth-floor neighbors asked to be left off. Two households have not replied. The player's preference is still open.
  move: Has heard the press is leaving the street and offered a thermos to the movers. Has no idea how Lin and the player spend Friday nights.
`,
  },
  {
    path: "world/locations/printshop.yaml",
    contents: `$document:
  id: location.larch-printshop
  ref: printshop
  title: Larch Street Printshop
  summary: A letterpress workshop in the middle of packing up for a move.
  aliases: []
Layout: Two stools and a drying rack stand beside the press. A little unboxed type and eight clean sheets remain. The bell is already off the door.
Current print: An unsigned blue test print depicts Number 19. It has no dedication and lists no residents. The drawing is dry so far.
Schedule: June closes at nine on Friday. Movers arrive Saturday at eight. Unfinished paper can be stored flat; the workshop reopens across town next Saturday.
Future visits: June plans to run the Saturday open workshop at the new address every month.
`,
  },
  {
    path: "world/locations/number-19.yaml",
    contents: `$document:
  id: location.larch-number-19
  ref: number-19
  title: Number 19
  summary: The apartment building where the player, Lin, and Noor live on different floors.
  aliases: []
Layout: Front hall with a shared notice board, narrow landings, and a basement laundry room with a twelve-minute spin cycle.
Permissions: The list tucked beneath the board records Noor and Lin as willing to be named. The fourth floor declined. Two households have not replied. Noor can check the list. Residents can also opt in later.
Daily life: The laundry notice board carries time swaps and requests for spare things. On Saturdays a loose group waters the planters and drinks tea on the steps.
`,
  },
  {
    path: "world/locations/noodle-shop.yaml",
    contents: `$document:
  id: location.larch-noodle-shop
  ref: noodle-shop
  title: The Glass Bowl
  summary: A noodle shop next door to the old printshop, with a shared counter and small tables.
  aliases: []
Schedule: On Fridays, kitchen orders end at 9:45 p.m. and the shop closes at ten.
Layout: The window table fits two and the counter takes solo diners. The dishwasher often hangs a damp towel on the hook between the two doors.
Daily life: A little chalkboard offers a pay-it-forward meal. Neighborhood people keep meeting here after the workshop moves.
`,
  },
  ...storyControlFiles(
    "en",
    "printshop",
    `# The print, the neighbors, and what follows

Keep the developing relationship grounded in what adults say and choose. Lin can hope for closeness and pay attention to the player's response. Accepting help with a print, eating together, friendship, and mutual romantic interest are separate possibilities. Let responses stay uncertain where the characters have left them uncertain. Keep opportunities to reconnect through ordinary life. Friendship, practical collaboration, a rain check, a respectful refusal, and gradual romance each have consequences worth following.

The shop move, paper supply, and people's permission to appear on the print constrain what can happen. Keep the subject and current form of the print with @printshop until copies leave the shop. Record actual invitations, commitments, and changes in each person's knowledge where they belong. Never infer the player's consent or feelings from courtesy. Permit an ordinary evening on the street with a finished or an unfinished print.
`,
  ),
];
