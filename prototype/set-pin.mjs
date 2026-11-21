// Run on the server: node set-pin.mjs --stdin
// Changing the PIN clears any lockout and logs out every device.
import { setPin } from './auth.mjs'

try {
  let pin = process.argv[2] ?? ''
  if (pin === '--stdin') {
    pin = ''
    for await (const chunk of process.stdin) pin += chunk
    pin = pin.trimEnd()
  }
  await setPin(pin)
  console.log('PIN updated. All devices must log in again.')
} catch (error) {
  console.error(error.message)
  console.error('Usage: node set-pin.mjs --stdin')
  process.exit(1)
}
