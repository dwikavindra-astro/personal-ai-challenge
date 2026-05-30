---
id: add-order
title: Add a new order
url: https://app.company.com/*
mode: agent
goal: Add a new order to the system and land on the order detail page.
triggers:
  - add order
  - new order
  - create order
---

Customers are picked from the "Customer" dropdown — start typing the customer
name to filter. Quantity must be greater than zero. The "Save" button is in
the top-right and is only enabled once required fields are filled. Success
looks like landing on a URL of the form /orders/<id> with the order number
visible in the page header.
