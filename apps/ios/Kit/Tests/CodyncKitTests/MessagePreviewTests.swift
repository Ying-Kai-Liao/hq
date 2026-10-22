import Testing
@testable import CodyncKit

@Test func rosterPreviewsReadFormattedRepliesWithoutMarkdownMarkers() {
    #expect(MessagePreview.text("算好了：**123 × 45 = 5,535** ✅\nDetails") == "算好了：123 × 45 = 5,535 ✅")
    #expect(MessagePreview.text("\n  > **Ready**: `my_file.ts`\r\nMore") == "Ready: my_file.ts")
    #expect(MessagePreview.text("### Release notes") == "Release notes")
    #expect(MessagePreview.text("  \n\t") == "")
    #expect(MessagePreview.text("2 * 3 = 6; my_file.ts") == "2 * 3 = 6; my_file.ts")
}
