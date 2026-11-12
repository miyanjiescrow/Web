# Security Specification - Mianji Escrow

## Data Invariants
1. A user cannot modify their own `wallet_balance` or `escrow_locked_balance`.
2. A user can only read/write deals where they are either the `buyer_id` or `seller_id`.
3. A deal status cannot be skipped (e.g., from `active` directly to `completed` without `work_submitted`).
4. Only the buyer can confirm payment and release funds.
5. All IDs must match strict regex patterns to prevent injection.

## The "Dirty Dozen" Payloads (Security Test Scenarios)

1. **Balance Spoofing**: User A tries to update `/users/userA { "wallet_balance": 9999999 }`.
2. **Identity Theft**: User A tries to create a deal with `buyer_id: "userB"` (someone else).
3. **Unauthorized Reading**: User A tries to `get` or `list` deals where they are neither buyer nor seller.
4. **Status Shortcutting**: Seller tries to update deal status to `completed` without buyer's confirmation.
5. **PII Leak**: User A tries to read the `phone_number` of all users in the system.
6. **Orphaned Deal**: Creating a deal with a `buyer_id` that doesn't exist in the system.
7. **Resource Poisoning**: Sending a 1MB string as a deal `title`.
8. **Shadow Update**: Adding a field `isAdmin: true` to a user profile update.
9. **Double Spend**: Trying to release funds from a deal that is already `cancelled`.
10. **Contact Scraping**: Reading another user's contact list.
11. **ID Injection**: Using a document ID like `../another_collection/stolen_data`.
12. **System Field Tampering**: Modifying `createdAt` or `updatedAt` to spoof timing.

## Test Runner (Logic Check)
We will implement Firestore Rules that explicitly block these 12 scenarios.
