// Run on the server: npm run set-pin -- 1234
// Changing the PIN clears any lockout and logs out every device.
import { setPin } from './auth.mjs'

try {
  await setPin(process.argv[2] ?? '')
  console.log('PIN updated. All devices must log in again.')
} catch (error) {
  console.error(error.message)
  console.error('Usage: npm run set-pin -- 1234')
  process.exit(1)
}
