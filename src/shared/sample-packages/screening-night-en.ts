import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const screeningNightEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `By the time you get back from class, the chalk arrow for FILM NIGHT points into a puddle. The bottom of the white sheet strung across the courtyard is wicking up rain. Pablo twists it free of the nearest bench. It slaps him gently across the ear.

“Forty-six RSVPs,” Mina says from under the eaves. She's still wearing her library name tag. She turns her phone so you can see a message from the student office. Room 204 is free if somebody collects the key by six. The indoor room seats twenty-eight.

“We could show the three shorts in shifts,” she says. “Please don't make me send a third change of plans.”

Hana looks up from her laptop. Beside the space bar are a packet of sesame crackers and a column of times she's typed out by hand. “My captions still need a run-through. We can use the dry hour for that. The courtyard will still be here next week.”

Pablo bundles the sheet up in both arms. “Or we do something in the common room tonight. I promised the commuters they'd get home before the last bus.”

A minute ago, the only thing you had planned was to get dinner after film night. Now Mina holds the phone out far enough for you to take it. “What do you think we should actually tell people?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.screening-night
  ref: current-situation
  title: A wet screen and a spare key
  summary: The film club must decide what to tell people waiting for tonight's program.
  aliases: []
background:
  Time: Thursday, 5:40 p.m., during autumn term
  Place: Rowan College courtyard, under the library eaves
Present:
  - { $ref: character.mina-shah }
  - { $ref: character.hana-kim }
  - { $ref: character.pablo-vega }
  - { $ref: character.player }
Pending decision: The club needs to decide whether and how to hold tonight's screening and how to get the word to everyone who signed up.
At the eaves: Mina is holding out her unlocked phone with the student office message still on screen, waiting for the player's input. The player has not taken it or answered for the club.
Open arrangements:
  - The outdoor screen is down. The three student shorts have not played.
  - The club has forty-six registrations. Room 204 holds twenty-eight and must be claimed by six. Nobody has accepted the offer.
  - The club can post a change, move, adapt, or postpone. The player can also help individual people or get dinner as planned.
`,
  },
  {
    path: "world/characters/player.yaml",
    contents: `$document:
  id: character.player
  ref: protagonist
  title: The player character
  summary: The player controls a Rowan College student who sometimes helps the film club.
  aliases: []
Connection: Helped paint today's signs before class. Knows the club from previous open meetings.
Authority: A friend and occasional volunteer. Can offer practical help, propose a change, or decline. Holds no official office that makes a decision binding.
`,
  },
  {
    path: "world/characters/mina.yaml",
    contents: `$document:
  id: character.mina-shah
  ref: mina
  title: Mina Shah
  summary: Film club organizer and evening library assistant.
  aliases: []
Motive: Wants the makers to see their films with an audience. She is also tired of being the only person who sends bad news and wants someone to take one concrete job.
Manner: Writes updates like notices until someone gets her to say what she's actually worried about. Grateful for practical help.
Knowledge:
  Room: Read the office's offer and knows the seat limit and six o'clock deadline. Two showings would take more than the club's approved booking.
  Audience: The registration form has forty-six names. She has not checked who needs an early departure or what access arrangements Hana has made.
Free time: Likes doing the crossword at the canteen counter after her evening desk shift.
`,
  },
  {
    path: "world/characters/hana.yaml",
    contents: `$document:
  id: character.hana-kim
  ref: hana
  title: Hana Kim
  summary: Student editor, caption maker, and director of one of the three shorts.
  aliases: []
Motive: Wants her uncle to be able to follow her short at a future screening without pointing out in front of the club why he needs captions. A test run matters to her more than an official premiere.
Manner: When checking captions, she cues up the shot in question so whoever is helping can watch the captions against the audio and spot the mismatch for themselves. A listener can use their own headphones or borrow hers if they need a pair.
Knowledge:
  Captions: The captions on her own film slip by two seconds after a long quiet shot. She knows which shot but has not repaired the export.
  Options: She has tested the club laptop with headphones. She has not been told which people are relying on the last bus.
Free time: Collects small sounds for a radio elective and trades snacks while she edits.
`,
  },
  {
    path: "world/characters/pablo.yaml",
    contents: `$document:
  id: character.pablo-vega
  ref: pablo
  title: Pablo Vega
  summary: Commuting student and the volunteer who borrowed the screen.
  aliases: []
Motive: Wants to keep his word to two commuters who stayed late to help. An informal meal would count as keeping them included, if the people who came for a film hear about the change in time.
Manner: Offers to carry things before offering an opinion. Is ready to ask about a shuttle or escort people to the bus stop if it would help.
Knowledge:
  Promise: Told two commuters that today's plans would finish in time for the 7:20 bus. They have already helped carry chairs and have not seen the room offer.
  Common room: Helped book a quiet event there last month. Knows chairs are movable but the room is shared and sound must stay low.
Free time: Swaps games and spare transit cards with people around the common room table.
`,
  },
  {
    path: "world/locations/courtyard.yaml",
    contents: `$document:
  id: location.rowan-courtyard
  ref: courtyard
  title: Rowan College courtyard
  summary: A meeting place between the library, student office, and common room.
  aliases: []
Layout: Library eaves shelter a narrow strip along the wall. The lawn and the painted courtyard arrows are exposed. Dry paths lead to the office and the common room.
Conditions: Water covers the two lowest steps. A damp screen and extension cord must dry before being used again. There is a roofed drying rack near the common room.
Daily life: People study on the dry steps, chalk meeting notices, and cross to the canteen at dusk.
`,
  },
  {
    path: "world/locations/room-204.yaml",
    contents: `$document:
  id: location.rowan-room-204
  ref: room-204
  title: Seminar room 204
  summary: A possible indoor screening room reached by lift or stairs.
  aliases: []
Access: The student office will hand a club volunteer the key until 6 p.m. The offer is for 6 to 7 p.m. only. Another group booked the room at seven.
Facilities: Twenty-eight chairs total including accessible spaces, a working projector, and stereo speakers. The three shorts with introductions run thirty-five minutes. One showing fits the booking.
Daily life: Student groups use the room by reservation. Extra evening time would require asking the group that booked after the club.
`,
  },
  {
    path: "world/locations/common-room.yaml",
    contents: `$document:
  id: location.rowan-common-room
  ref: common-room
  title: Common room and canteen
  summary: A busy shared room with food, movable chairs, and a path to the bus stop.
  aliases: []
Access: Anyone at the college may drop in. Leave tables for people eating or working. Shared-room policy requires headphone use for film audio.
Facilities: Two tables have spare outlets and there is a counter serving dinner until seven. A paper board carries volunteer requests and bus schedules.
Daily life: The last bus for the outer suburbs leaves the stop beyond the front gate at 7:20 p.m. A covered corridor leads to the gate in five minutes.
`,
  },
  ...storyControlFiles(
    "en",
    "courtyard",
    `# Life around the film club

Treat the room, deadline, show length, bus, and access needs as concrete constraints. The club can change the plan by asking people, making compromises, or discovering new resources. Let the player back any person, propose something different, help a little, or leave the club to decide. People are free to disagree and can still share dinner the next day. Everyday scenes such as editing, studying, eating, or waiting for the bus can carry later turns.

Keep promises to people and bookings distinct from ideas tossed around. Write decisions and who has been informed to the appropriate document. Keep the press of time proportionate to the scenes that actually pass. Resolve tonight's event when the player and others have acted, with room for future classes, rehearsals, or ordinary evenings together.
`,
  ),
];
