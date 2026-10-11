// The widget bundle: the run's Live Activity (lock screen + Dynamic Island,
// with Done) and a Control Center button that opens Labee in Voice mode.
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct LabeeWidgets: WidgetBundle {
  var body: some Widget {
    RunActivityWidget()
    SiriActivityWidget()
    TalkControl()
  }
}

// MARK: - Live Activity

struct RunActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RunActivityAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(Color("$widgetBackground"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text("Step \(context.state.step)/\(context.state.total)")
            .font(.caption).foregroundStyle(.secondary)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if let ends = context.state.timerEndsAt, ends > Date() {
            Text(timerInterval: Date()...ends, countsDown: true)
              .font(.caption.monospacedDigit())
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(alignment: .firstTextBaseline) {
            Text(context.state.stepText)
              .font(.footnote)
              .lineLimit(2)
            Spacer()
            if context.state.status == "running" {
              Button(intent: DoneStepIntent(runId: context.attributes.runId)) {
                Text("Done").font(.footnote.bold())
              }
              .buttonStyle(.borderedProminent)
              .tint(Color("$accent"))
            }
          }
        }
      } compactLeading: {
        Text("\(context.state.step)/\(context.state.total)").font(.caption2)
      } compactTrailing: {
        if let ends = context.state.timerEndsAt, ends > Date() {
          Text(timerInterval: Date()...ends, countsDown: true)
            .font(.caption2.monospacedDigit())
            .frame(maxWidth: 44)
        } else {
          Image(systemName: "flask")
        }
      } minimal: {
        Image(systemName: "flask")
      }
    }
  }
}

struct LockScreenView: View {
  let context: ActivityViewContext<RunActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(context.attributes.protocolName)
          .font(.caption.bold())
          .foregroundStyle(.secondary)
        Spacer()
        Text(context.state.status == "running" ? "Step \(context.state.step) of \(context.state.total)" : context.state.status.capitalized)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(context.state.stepText)
        .font(.body)
        .lineLimit(3)
      HStack(alignment: .center) {
        if let ends = context.state.timerEndsAt {
          if ends > Date() {
            Label {
              Text(timerInterval: Date()...ends, countsDown: true)
                .monospacedDigit()
            } icon: {
              Image(systemName: "timer")
            }
            .font(.title3.weight(.semibold))
          } else if let label = context.state.timerLabel {
            Label("\(label) done", systemImage: "timer")
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(.orange)
          }
        }
        Spacer()
        if context.state.status == "running" {
          Button(intent: DoneStepIntent(runId: context.attributes.runId)) {
            Text("Done").bold()
          }
          .buttonStyle(.borderedProminent)
          .tint(Color("$accent"))
        }
      }
    }
    .padding(14)
  }
}

// MARK: - The Siri agent's Live Activity (siri-agent design, phase 4)

struct SiriActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SiriActivityAttributes.self) { context in
      SiriLockScreenView(context: context)
        .activityBackgroundTint(Color("$widgetBackground"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            if let title = context.state.chatTitle {
              Text(title).font(.caption.bold()).foregroundStyle(.secondary)
            }
            Text(context.state.spoken).font(.footnote).lineLimit(3)
            SiriButtons(context: context)
          }
        }
      } compactLeading: {
        Image(systemName: "waveform")
      } compactTrailing: {
        if context.state.unread > 0 {
          Text("\(context.state.unread)").font(.caption2.bold())
        }
      } minimal: {
        Image(systemName: "waveform")
      }
    }
  }
}

struct SiriLockScreenView: View {
  let context: ActivityViewContext<SiriActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Label(context.state.chatTitle ?? "Labee", systemImage: "waveform")
          .font(.caption.bold())
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Spacer()
        Text(context.state.at, style: .time)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(context.state.spoken)
        .font(.body)
        .lineLimit(4)
      if let line = context.state.runLine {
        Text(line).font(.caption).foregroundStyle(.secondary)
      }
      SiriButtons(context: context)
    }
    .padding(14)
  }
}

struct SiriButtons: View {
  let context: ActivityViewContext<SiriActivityAttributes>

  var body: some View {
    HStack(spacing: 8) {
      if #available(iOS 26.0, *) {
        Button(intent: NewsLiveIntent()) {
          Label(context.state.unread > 0 ? "News (\(context.state.unread))" : "Any news", systemImage: "bell")
            .font(.footnote.bold())
        }
        .buttonStyle(.bordered)
        if let runId = context.state.runId {
          Button(intent: DoneStepIntent(runId: runId)) {
            Label("Done", systemImage: "checkmark").font(.footnote.bold())
          }
          .buttonStyle(.borderedProminent)
          .tint(Color("$accent"))
        }
      }
      Spacer()
      if let id = context.state.sessionId, let url = URL(string: "labee://session/\(id)?voice=1") {
        Link(destination: url) {
          Label("Open", systemImage: "arrow.up.right.square").font(.footnote.bold())
        }
        .buttonStyle(.bordered)
      }
    }
  }
}

// MARK: - Control Center

/// Lab mode in one press: opens the run in progress (or a new chat) already
/// listening, so the next thing said needs no app name and no Siri. Meant for
/// the Action Button, Control Center and the Lock Screen. The control kind is
/// unchanged so a control someone already placed keeps working.
@available(iOS 26.0, *)
struct TalkControlIntent: AppIntent {
  static let title: LocalizedStringResource = "Labee Lab Mode"
  static let description = IntentDescription("Open Labee listening, on your run if one is going.")
  static let openAppWhenRun = true

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(URL(string: "labee://voice")!))
  }
}

@available(iOS 26.0, *)
struct TalkControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "online.labee.mobile.talk") {
      ControlWidgetButton(action: TalkControlIntent()) {
        Label("Lab mode", systemImage: "mic")
      }
    }
    .displayName("Labee Lab Mode")
    .description("Open Labee listening, on your run if one is going.")
  }
}
