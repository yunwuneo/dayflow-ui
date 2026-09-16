import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.07, green: 0.43, blue: 0.39, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
context.setLineWidth(42)
context.strokeEllipse(in: CGRect(x: 370, y: 370, width: 284, height: 284))
context.setLineWidth(38)
context.setLineCap(.round)
for index in 0..<12 {
    let angle = Double(index) * .pi / 6
    context.move(to: CGPoint(x: 512 + cos(angle) * 225, y: 512 + sin(angle) * 225))
    context.addLine(to: CGPoint(x: 512 + cos(angle) * 290, y: 512 + sin(angle) * 290))
    context.strokePath()
}
let url = URL(fileURLWithPath: "ios/Dayflow/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
