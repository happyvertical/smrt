## Overview

Affiliates lets partners and customers send people your way and earn a reward
when it leads to a sale. You set up a program that says what a referral earns,
sign up the people who will refer, record each person they send, and see what
each affiliate has earned and what has been paid out.

## Tasks

### Sign up an affiliate

1. Open the list of affiliates and choose **New**.
2. Type their **{field:Referrer.displayName}**.
3. Save. They stay pending until you approve them by setting the **{field:Referrer.status}**.

### Set up a program

1. Open the programs and choose **New**.
2. Give the program a **{field:ReferralProgram.name}** your affiliates will understand.
3. Set the **{field:ReferralProgram.status}** to active when you are ready to start.
4. Save.

### Record a referral

1. Open the referrals and choose **New**.
2. Pick the **{field:Referral.referrerId}** who sent the person and the **{field:Referral.programId}** it belongs to.
3. Save. The referral stays pending until it leads to a sale.

### Check what an affiliate has earned

1. Open the commissions and find the affiliate.
2. Read the **{field:Commission.amountCents}** and the **{field:Commission.status}** of each one.
3. A commission moves from pending to approved, then payable, then paid as it is worked through.

### Check a payout

Payouts are made by the commission payout service, not by hand in the app. You
can see what has been paid.

1. Open the payouts.
2. Read the **{field:CommissionPayout.earnerId}**, the **{field:CommissionPayout.totalAmountCents}** and the **{field:CommissionPayout.status}**.
3. A payout is waiting, approved, being sent, then completed. It shows failed or rejected if the money did not go out.
