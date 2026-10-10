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

// MARK: - Control Center

/// Opens the app in Voice mode on the latest chat (the "Talk to Labee" phrase
/// as a button). Opening the app is all a control needs to do here.
@available(iOS 26.0, *)
struct TalkControlIntent: AppIntent {
  static let title: LocalizedStringResource = "Talk to Labee"
  static let description = IntentDescription("Open Labee in voice mode.")
  static let openAppWhenRun = true

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(URL(string: "labee://session/new?voice=1")!))
  }
}

@available(iOS 26.0, *)
struct TalkControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "online.labee.mobile.talk") {
      ControlWidgetButton(action: TalkControlIntent()) {
        Label("Talk to Labee", systemImage: "mic")
      }
    }
    .displayName("Talk to Labee")
    .description("Open Labee in voice mode.")
  }
}
