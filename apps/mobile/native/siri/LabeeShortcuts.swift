// The phrases (docs/siri-design.md §2.2, run-design §3). Apple allows ten
// App Shortcuts per app and only entity or enum parameters in a phrase, so
// the run verbs share one intent with an enum, and free text is asked for.
// Every phrase carries the app name; that is what keeps "done" from firing
// during ordinary Siri use.
import AppIntents

@available(iOS 26.0, *)
struct LabeeShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartRunIntent(),
      phrases: [
        "Start \(\.$protocolEntity) in \(.applicationName)",
        "Run \(\.$protocolEntity) in \(.applicationName)",
        "\(.applicationName), start \(\.$protocolEntity)",
      ],
      shortTitle: "Start a run",
      systemImageName: "play.circle"
    )
    AppShortcut(
      intent: RunStepIntent(),
      phrases: [
        "\(.applicationName), \(\.$action)",
        "\(\.$action) in \(.applicationName)",
        "Tell \(.applicationName) \(\.$action)",
      ],
      shortTitle: "Run step",
      systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: StartTimerIntent(),
      phrases: [
        "Start the \(.applicationName) timer",
        "Start a \(.applicationName) timer for \(\.$length)",
        "Set a \(.applicationName) timer for \(\.$length)",
      ],
      shortTitle: "Start a timer",
      systemImageName: "timer"
    )
    AppShortcut(
      intent: NoteIntent(),
      phrases: [
        "Note in \(.applicationName)",
        "Add a note in \(.applicationName)",
        "\(.applicationName), note",
      ],
      shortTitle: "Note",
      systemImageName: "note.text"
    )
    AppShortcut(
      intent: HowMuchIntent(),
      phrases: [
        "How much \(\.$material) in \(.applicationName)",
        "\(.applicationName), how much \(\.$material)",
        "\(.applicationName), how much",
      ],
      shortTitle: "How much",
      systemImageName: "scalemass"
    )
    AppShortcut(
      intent: TellLabeeIntent(),
      phrases: [
        "Tell \(.applicationName)",
        "Message \(.applicationName)",
        "Tell \(.applicationName) in \(\.$chat)",
      ],
      shortTitle: "Tell Labee",
      systemImageName: "bubble.left"
    )
    AppShortcut(
      intent: AskLabeeIntent(),
      phrases: [
        "Ask \(.applicationName)",
        "Ask \(.applicationName) about \(\.$chat)",
      ],
      shortTitle: "Ask Labee",
      systemImageName: "questionmark.bubble"
    )
    AppShortcut(
      intent: AnswerLabeeIntent(),
      phrases: [
        "Answer \(.applicationName)",
        "Reply to \(.applicationName)",
      ],
      shortTitle: "Answer Labee",
      systemImageName: "arrowshape.turn.up.left"
    )
    AppShortcut(
      intent: ChatActionIntent(),
      phrases: [
        "\(.applicationName), \(\.$action)",
        "What's \(.applicationName) doing",
        "Stop \(.applicationName)",
      ],
      shortTitle: "Agent status",
      systemImageName: "waveform"
    )
    AppShortcut(
      intent: TalkToLabeeIntent(),
      phrases: [
        "Talk to \(.applicationName)",
        "Talk to \(.applicationName) about \(\.$chat)",
      ],
      shortTitle: "Talk to Labee",
      systemImageName: "mic"
    )
  }
}
