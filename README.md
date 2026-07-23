# 🍽️ At-Home Meal Planner

Search recipes online, pick your dishes for the week, and get an automatic grocery
list grouped by store aisle (with duplicate ingredients combined). Built for home use.

---

## One-time setup (about 5 minutes)

### 1. Install Node.js
Download the **LTS** version and run the installer (accept the defaults):
👉 https://nodejs.org/en/download

Verify it worked — open **PowerShell** and run:
```powershell
node --version
```
You should see something like `v20.x.x`.

### 2. Get a free Spoonacular API key
1. Sign up (free): https://spoonacular.com/food-api
2. Open the console dashboard: https://spoonacular.com/food-api/console#Dashboard
3. Copy your **API Key**.

The free plan allows plenty of searches per day for a household.

### 3. Add your key to the app
In this project folder, make a copy of `.env.example` and name it `.env`, then paste
your key in. In PowerShell you can do it in one step:
```powershell
Copy-Item .env.example .env
notepad .env
```
Change this line and save:
```
SPOONACULAR_API_KEY=paste_your_key_here
```

### 4. Install the app's dependencies
In PowerShell, from this folder:
```powershell
npm install
```

---

## Running it

Every time you want to use the planner:
```powershell
npm start
```
Then open your browser to **http://localhost:3000**

To use it on your **phone** while on the same home Wi-Fi: find your computer's local IP
(run `ipconfig` and look for the IPv4 address, e.g. `192.168.1.20`) and visit
`http://192.168.1.20:3000` on the phone. Leave the PowerShell window open while using it.

Press `Ctrl + C` in PowerShell to stop the server.

---

## How to use

> 🌾 **Gluten-free** is on by default (a checkbox you can toggle off). Optionally tick
> **Under 500 cal / serving** for lighter meals. Calories and full nutrition
> (protein/carbs/fat per serving) appear on each recipe card and in the detail view.

1. **Find Recipes** — search by dish or ingredient, and/or pick a **category** from the
   left column (Appetizers, Soups, Salads, Entrées). Click a photo or title to see
   ingredients + nutrition. Tap **＋ Add to plan** to add to the currently-selected week.
2. **Planner** — plan a **month at a time**. Use ◀ ▶ to move between months. Each week is
   a bucket: tap **＋ Add dishes** to make it the target, then add recipes from Find Recipes.
3. **Grocery List** — from any week in the Planner, tap **🛒 List**. It combines that week's
   ingredients, groups them by aisle, and sums duplicates. Check items off as you shop, or
   **Copy** / **Print** the list.

Your whole month's plan is saved in the browser automatically, so it's still there next time.
The app uses a **dark theme**.

---

## Notes
- Your API key stays in `.env` on your computer and is never exposed to the browser.
- `.env` and `node_modules` are git-ignored, so it's safe to version-control this folder.
- If you see a "No API key configured" banner, re-check step 3 and restart with `npm start`.
