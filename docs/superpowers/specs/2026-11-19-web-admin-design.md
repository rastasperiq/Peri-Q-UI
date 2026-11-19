# Website admin dashboard: design

Date: 19 November 2026. Status: awaiting owner approval.

## Why

The live website (rastasperiq.co.za) now takes real card payments, but the
only admin tool is the Android app's Owner Dashboard. The installed app still
points at the old database, and the new APK/AAB is not built or on Play yet.
So today nobody can see or run live orders. The website must be able to do
everything the app's admin can do, so the business never depends on the app.

## Goals

- An admin area at `/admin` on the website with the same powers as the app's
  Owner Dashboard:
  - **Orders**: live list of incoming orders; customer name, phone, order type,
    delivery address or collection, items (spice, add-ons, notes), total,
    payment status. Actions: Accept & start cooking (pending → preparing),
    Mark ready (preparing → ready), Mark completed (ready → completed),
    Reject (pending → cancelled, with a confirm step). Metrics: active orders,
    today's sales, completed.
  - **New-order alert**: while the admin page is open, a new order plays a
    sound and shows a pop-up, without a page refresh.
  - **Menu items**: list, add, edit, delete (confirm), show/hide, photo upload
    (JPG/PNG/WebP under 5 MB, `menu-images` bucket), price, category,
    description, prep minutes, spice levels, add-ons.
  - **Categories**: add, edit, delete (confirm), show/hide.
  - **Today's Special**: on/off, label, headline, supporting text, linked menu
    item, image.
  - **Store settings**: store accepting orders, pickup on/off, delivery on/off,
    delivery pricing (base fee, per-km price, minimum fee, maximum distance,
    free-delivery threshold), opening and closing time.
- Works on a laptop, tablet and phone browser.
- Same admin accounts as the app; nothing new to remember.

## Non-goals

- Refunds. They stay in the Yoco dashboard (go-live checklist 3c). The order
  page shows a reminder that rejecting a paid order does not refund it.
- Push notifications with the tab closed (sound in an open tab was chosen).
- Making people admins, reports, exports, or the admin audit log screen.
- Any change to the Android app.

## Anti-goals (a failure even if it works)

- A customer or anonymous visitor can open or use any admin action.
- Any admin action uses the master (service-role) database key.
- The admin area leaks into search results or the customer navigation.
- It reaches LIVE before the owner has tried it on staging.

## Constraints

- **No database changes.** The existing rules already give a signed-in admin
  (`profiles.role = 'admin'`, checked by `is_admin()`) read/write on orders,
  menu items, categories, app settings and menu-image uploads, and refuse
  everyone else. Order status changes are checked by
  `validate_order_status_transition()`, so an invalid jump is refused by the
  database whatever the page does.
- Orders are only created once paid (the checkout writes to
  `checkout_intents` first), so the order list contains paid orders.
- `orders` is already in the realtime publication; the app's order screen
  relies on it.
- Website stack: Next.js 16, React 19, Tailwind 4, `@supabase/supabase-js`,
  vitest + Testing Library. No new dependencies.
- TEST/LIVE environment guard and banner stay as they are.
- Deploy order: `staging` branch → owner tests with the demo admin on TEST →
  merge to `main` for LIVE only on the owner's OK.

## Approaches considered

- **A. Browser pages using the admin's own sign-in and the existing database
  rules (chosen).** Least new code, same behaviour as the app, and security
  is enforced by the database, not the page.
- B. Website server routes using the master key with an admin check. Rejected:
  duplicates every database rule, and a bug in one route would bypass them.
- C. A separate admin site/subdomain. Rejected: a second project, domain and
  key set for no benefit at this size.

The owner picked **A**, and **sound in an open tab** for alerts.

## Design

### Pages (all client-rendered, under `website/app/admin/`)

| Path | Content |
|---|---|
| `/admin` | Orders: metrics row, active orders (oldest first), recent finished orders, alert toggle |
| `/admin/menu` | Menu items list with show/hide toggle, edit, delete; "Add item" |
| `/admin/menu/[id]` and `/admin/menu/new` | Item editor with photo upload |
| `/admin/categories` | Categories list and add/edit dialog |
| `/admin/special` | Today's Special form |
| `/admin/settings` | Store availability, delivery pricing, hours |

A shared admin layout gives a simple tab bar (Orders, Menu, Categories,
Special, Settings), the environment badge (TEST / LIVE), and sign out. It
sets `robots: noindex` and is not linked from the customer site; the admin
reaches it by typing `/admin` or from a small "Admin" link on the account page
shown only to admins.

### Access

- `/admin` checks the browser session. Not signed in → the existing email
  sign-in form. Signed in but not admin (`profiles.role`) → "This account is
  not an admin" with sign out. Anonymous guest sessions count as not signed in.
- The page check is for usability only; the database rules are the real lock.

### Orders and the alert

- Load the latest 100 orders with their items, like the app.
- Subscribe to realtime changes on `orders`; on any change, reload the list
  (simple and matches the app). If the subscription drops, fall back to
  reloading every 30 seconds and show "Reconnecting…".
- A new order id that wasn't in the previous list → play a short sound,
  show a pop-up "New order #123 – R…", and flash the tab title.
- Browsers block sound until the user clicks once, so the page shows an
  "Enable order sound" button; the choice is remembered on that device. The
  button turns into "Sound on" with a test-sound link.
- The screen asks the browser to stay awake while the Orders page is open,
  where the browser supports it.
- Today's sales = paid orders created today (South Africa time), not
  cancelled. (The app sums all loaded orders; the website uses the correct
  figure.)

### Writes

- All writes use the browser client with the admin's session, the same table
  calls as the app (`orders.update({status})`, `menu_items`, `menu_categories`,
  `app_settings` upsert for id `default`, storage `menu-images`).
- Each action shows saving/success/error states; database refusals are shown
  in plain words ("This order has already moved on – refreshing").

### Testing

- vitest + Testing Library for: access gate (signed out, customer, admin),
  order actions and allowed buttons per status, new-order detection and
  sound trigger, sales metric, settings and menu forms (validation and the
  payload sent), mocked Supabase client.
- Manual on staging with `admin@demo.rastasperiq.test`: place a test order as
  `customer1` in another browser, hear the alert, move it through every
  status, edit the menu and settings and see them on the customer pages.

## Left to the builder

- Component breakdown, styling within the existing site look, sound file
  (a short generated tone, no third-party audio), exact copy.
- Whether the item editor is a page or a dialog.
