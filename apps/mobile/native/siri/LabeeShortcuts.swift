// The phrases (docs/siri-agent-design.md §7). Apple allows ten App
// Shortcuts per app and only entity or enum parameters in a phrase, so free
// text is asked for, and the run verbs share one intent with an enum. Every
// phrase carries the app name; "Lab Helper", "Lab Bee" and "Lab Assistant"
// stand in for it (INAlternativeAppNames), since "Labee" is often misheard.
import AppIntents

@available(iOS 26.0, *)
struct LabeeShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: SayToLabeeIntent(),
      phrases: [
        "Tell \(.applicationName)",
        "Ask \(.applicationName)",
        "Message \(.applicationName)",
        "Hey \(.applicationName)",
      ],
      shortTitle: "Tell Labee",
      systemImageName: "bubble.left"
    )
    AppShortcut(
      intent: CatchUpIntent(),
      phrases: [
        "Any news from \(.applicationName)",
        "What's new in \(.applicationName)",
        "\(.applicationName) news",
        "What's \(.applicationName) doing",
      ],
      shortTitle: "Any news",
      systemImageName: "bell"
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
