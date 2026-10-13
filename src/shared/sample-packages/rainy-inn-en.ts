import type { SampleContentPackage } from "./index.ts";

export const rainyInnEnglish: SampleContentPackage = {
  title: "A Letter at the Rain Lantern Inn",
  files: [
    {
      path: "opening.md",
      contents: `Rain patters from the inn's eaves. The little brass bell above you is still swaying, and the lobby smells of ginger tea. A lamp casts a warm circle across the wooden counter.

Behind it, a woman in a green apron lifts an empty blue saucer, checks underneath, and sets it down again. “Well, it hasn't grown legs.”

A guest in a grey cardigan looks up from the window table. “A pale blue envelope. It's for my sister, and I haven't sealed it yet.” Beside the counter, a young postal runner pauses with a damp ledger tucked against his chest.

The woman offers you a dry towel. “Welcome in. We're having a small mystery with a letter. Would you mind lending us a fresh pair of eyes?” The counter, umbrella stand, and window table are all within the lamplight. She waits for your answer.
`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.rainy-inn
  ref: current-situation
  title: An empty saucer in the lamplight
  summary: A small search in the Rain Lantern Inn's lobby.
  aliases: []
背景:
  Time: An autumn evening, nine o'clock, steady rain
  Place: Rain Lantern Inn lobby, Brookbridge
Present:
  - $ref: character.nora
  - $ref: character.evelyn
  - $ref: character.kit
In progress:
  Letter search: Evelyn's pale blue envelope is no longer on the counter's blue saucer. Nobody has begun a methodical search of the lobby.
Awaiting a response:
  Speaker: { $ref: character.nora }
  Invitation: Welcome in. We're having a small mystery with a letter. Would you mind lending us a fresh pair of eyes?
Immediate circumstances:
  - You have just arrived at the doorway. Nora's offered towel has not been taken.
  - Kit holds the ledger and has paused wiping its damp corner.
`,
    },
    {
      path: "world/characters/nora.yaml",
      contents: `$document:
  id: character.nora
  ref: nora
  title: Nora
  summary: The Rain Lantern's attentive innkeeper, quick to offer practical kindness.
  aliases: []
Appearance: Short hair, soft features, a dusting of flour on one cuff.
Clothing: A cream shirt, forest-green apron, and soft indoor shoes.
Temperament: Patient; looks for a remedy before laying blame.
Relationships:
  Evelyn:
    Person: { $ref: character.evelyn }
    View: A familiar guest whose plant stories brighten the lobby; hopes she can rest without worrying tonight.
  Kit:
    Person: { $ref: character.kit }
    View: A neighbour's helpful son, sometimes distracted; willing to hear him out when something goes wrong.
Knowledge:
  Letter: Remembers putting Evelyn's envelope on the blue saucer, then leaving to make tea. Did not watch the counter after that.
  Basis: { $ref: event.letter-entrusted }
`,
    },
    {
      path: "world/characters/evelyn.yaml",
      contents: `$document:
  id: character.evelyn
  ref: evelyn
  title: Evelyn
  summary: A travelling botanical illustrator who shares discoveries in letters.
  aliases: []
Appearance: Round glasses and a faint smudge of graphite on her fingertips.
Clothing: A grey cardigan and navy trousers; her brown rain cape hangs by the umbrellas.
Temperament: Observant and deliberate; double-checks small details when worried.
Relationships:
  Nora:
    Person: { $ref: character.nora }
    View: A trusted innkeeper; the missing letter has not made her suspect deliberate concealment.
  Kit:
    Person: { $ref: character.kit }
    View: Met him this evening; trusts his postal expertise but knows little about his habits.
Important belongings:
  Letter for her sister: An unsealed pale blue envelope containing a page of news and a hand-drawn leaf study, intended for tomorrow's post.
Knowledge:
  Letter: Knows she entrusted it to Nora and now sees an empty saucer; does not know where it went afterward.
  Basis: { $ref: event.letter-entrusted }
`,
    },
    {
      path: "world/characters/kit.yaml",
      contents: `$document:
  id: character.kit
  ref: kit
  title: Kit
  summary: Brookbridge's young postal runner, always willing to help a neighbour.
  aliases: []
Appearance: Rain-flattened hair and a small dimple when he smiles.
Clothing: An unbuttoned blue raincoat, striped shirt, and canvas shoes with wet toes.
Temperament: Eager and easily distracted; owns up to mistakes and tries to put them right.
Relationships:
  Nora:
    Person: { $ref: character.nora }
    View: A neighbour he has known since childhood; trusts her and wants to be useful.
  Evelyn:
    Person: { $ref: character.evelyn }
    View: A new acquaintance with intriguing drawings; hopes to ask about the leaves she sketches.
Knowledge:
  Remembered action: Moved a pale blue envelope to make room for his wet ledger, slipping it inside the back cover. Assumed the envelope was empty.
  Current understanding: Has not caught what Evelyn is looking for or connected her letter with the envelope he moved.
Belongings:
  Ledger: Held against his chest; a corner of the back cover is damp.
`,
    },
    {
      path: "world/locations/rain-lantern-inn.yaml",
      contents: `$document:
  id: location.rain-lantern-inn
  ref: rain-lantern-inn
  title: Rain Lantern Inn
  summary: A small inn by Brookbridge's bridge, where neighbours shelter over tea.
  aliases: []
Lobby: A wooden counter faces the entrance, with a blue saucer and brass lamp on top. A small table stands by the window; the umbrellas rest beside the door.
Daily life: Guests can rest over ginger tea; the innkeeper sometimes holds letters for familiar visitors until morning.
`,
    },
    {
      path: "world/events/letter-entrusted.yaml",
      contents: `$document:
  id: event.letter-entrusted
  ref: letter-entrusted
  title: A letter left for safekeeping
  summary: Evelyn's earlier arrangement with Nora to keep a letter at the counter.
  aliases: []
When: About half an hour earlier this evening
Account: Evelyn gave Nora an unsealed pale blue envelope, explaining that it held a letter and leaf drawing for her sister. Nora put it on the blue saucer while Evelyn watched.
Words: Evelyn said, “I'll seal it in the morning. Could you keep it here until then?” Nora agreed.
Source: Both Evelyn and Nora were at the counter.
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 3 }
  - slot: { kind: catalog, directory: locations, maxEntries: 4 }
  - slot: { kind: catalog, directory: events, maxEntries: 12 }
  - slot: { kind: document, document: "@rain-lantern-inn" }
  - slot:
      kind: reference_targets
      from:
        document: "@current-situation"
        locator: { yaml: [Present] }
      maxEntries: 3
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
`,
    },
    {
      path: "control/blocks/world.md",
      contents: `<!-- opening.md is the visible opening; world/current-situation.yaml holds the background and pending response; characters/ holds each person's state, relationships, and knowledge; locations/ describes places; events/ records shared past events; frame.yaml selects play material; player-views.yaml selects status values. Adapt these files to write your own story. -->

# Genre and boundaries

Focus on small-town inn life, conversation, and gentle mysteries arising from objects, memories, and misunderstandings. Keep the tone warm and suitable for all ages, without violence, adult content, or life-threatening conspiracies. Sharing a letter's private contents is up to its writer and recipient.

## Documents and where changes belong

Keep relationships, opinions, and knowledge in each person's own world/characters/ document, without a shared truth or secret field. Record events that need shared reference in world/events/; link to the account rather than copying it into each character. Lasting changes to places belong in world/locations/. Keep the letter among its owner's important belongings until independent transfer tracking warrants a separate document.
`,
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1
views:
  - id: scene-status
    title: Right now
    items:
      - id: time
        label: Time
        select:
          document: "@current-situation"
          locator: { yaml: [背景, Time] }
      - id: place
        label: Place
        select:
          document: "@current-situation"
          locator: { yaml: [背景, Place] }
`,
    },
  ],
};
