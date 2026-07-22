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

> 🌾🚫 **Every recipe is gluten-free.** Searches are automatically filtered to exclude
> gluten (celiac-safe) — there's no way to turn this off. Optionally tick **Under 500 cal
> / serving** to show only lighter meals. Calories and full nutrition (protein/carbs/fat
> per serving) appear on each recipe card and in the recipe detail view.

1. **Find Recipes** — search by dish or ingredient (e.g. "salmon", "chicken tacos").
   Click a photo or title to see ingredients + nutrition. Tap **＋ Add to week**.
2. **This Week** — review your chosen dishes; remove any you change your mind about.
3. **Make Grocery List** — combines all ingredients, groups them by aisle, and sums
   duplicates. Check items off as you shop, or **Copy** / **Print** the list.

Your weekly picks are saved in the browser automatically, so they're still there next time.

---

## Notes
- Your API key stays in `.env` on your computer and is never exposed to the browser.
- `.env` and `node_modules` are git-ignored, so it's safe to version-control this folder.
- If you see a "No API key configured" banner, re-check step 3 and restart with `npm start`.
