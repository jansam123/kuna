#if os(iOS)
import KunaCore
import SwiftUI

struct ReviewScreen: View {
  let model: AppModel
  let key: String
  @Binding var path: [Route]
  let open: OpenAgents
  var body: some View { Text("Review") }
}
#endif
