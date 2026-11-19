/* QR Dine - Supabase-connected frontend */

const supabaseClient = window.qrDineSupabase;

const money = (n) => "₹" + Number(n || 0).toFixed(2);
const imageFallback = "images/dishes/default-food.svg";

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

let foods = [];

async function fetchFoods() {
  const { data, error } = await supabaseClient.rpc("get_menu_by_qr", {
    p_qr_code: qrCode,
  });

  if (error) {
    console.error("Menu loading error:", error);
    toast(
      "Unable to load this table menu. Check the QR code and Supabase setup.",
    );
    return;
  }

  tableNo = Number(data.table.table_number);
  foods = (data.foods || []).map((food) => ({
    ...food,
    time: food.preparation_time,
    special: food.is_special,
    ingredients: food.ingredients || [],
  }));

  updateHeader();
  renderMenu();
}

let chefOrdersChannel = null;
let orders = load("qd_orders", []);
let cart = load("qd_cart", []);
let chefOrders = [];
let staffUser = null;
const STAFF_HOTEL_ID = 1;
const HOTEL_CODE = "HOTEL1";
const HOTEL_NAME = "QR Dine Demo Hotel";
const MENU_IMAGES_BUCKET = "menu-images";
const urlParams = new URLSearchParams(location.search);

const savedSessionTable = Number(sessionStorage.getItem("qd_selected_table"));
let tableNo = Number(urlParams.get("table")) || (savedSessionTable >= 1 && savedSessionTable <= 12 ? savedSessionTable : 1);
let qrCode =
  urlParams.get("qr") || `${HOTEL_CODE}-TABLE${String(tableNo).padStart(2, "0")}`;
let activeCategory = "All";
let discountRate = 0;
let staffRole = sessionStorage.getItem("qd_staff_role") || null;
let currentOrderId = load("qd_currentOrder", null);
let trackingTokens = load("qd_trackingTokens", []);
let trackedOrders = [];
let customerTrackingTimer = null;
let activeModalFoodId = null;
let modalFoodQty = 1;
let selectedFoodImageFile = null;
let selectedFoodPreviewUrl = null;

const statusOptions = ["Pending", "Preparing", "Ready", "Served"];

function persist() {
  save("qd_orders", orders);
  save("qd_cart", cart);
}

/* PAGE NAVIGATION AND ACCESS CONTROL */

function showPage(id) {
  if (staffRole === "chef" && id !== "chef") {
    toast("Chef accounts can access only the Chef page.");
    id = "chef";
  }

  const roleRequired = {
    admin: "admin",
    analytics: "admin",
    chef: "staff",
  }[id];

  if (roleRequired && !hasAccess(roleRequired)) {
    openStaffLogin(id);
    return;
  }

  document.querySelectorAll(".page").forEach((p) => {
    p.classList.toggle("active", p.id === id);
  });

  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === id);
  });

  document.getElementById("nav").classList.remove("open");

  if (id === "menu") renderMenu();
  if (id === "waiting") {
    renderWaiting();
    startCustomerTracking();
  } else {
    stopCustomerTracking();
  }
  if (id === "payment") updatePayment();
  if (id === "admin") {
    initAdminQrGenerator();
    fetchAdminDashboard();
  }
  if (id === "analytics") renderAnalytics();
  if (id === "chef") renderChef();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openCartPanel() {
  if (!document.getElementById("menu").classList.contains("active")) {
    showPage("menu");
  }
  renderCart();
  document.getElementById("cartSidebar").scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
}

function hasAccess(required) {
  if (required === "admin") return staffRole === "admin";
  if (required === "staff")
    return staffRole === "admin" || staffRole === "chef";
  return true;
}

let pendingStaffPage = null;

function openStaffLogin(targetPage = null) {
  pendingStaffPage = targetPage;
  document.getElementById("staffLoginModal").classList.remove("hidden");
  document.getElementById("loginError").textContent = "";
  document.getElementById("loginPassword").value = "";
  document.getElementById("loginUsername").focus();
}

function closeStaffLogin() {
  document.getElementById("staffLoginModal").classList.add("hidden");
  pendingStaffPage = null;
}

function updateLoginHint() {
  document.getElementById("loginError").textContent = "";
}

async function staffLogin(event) {
  event.preventDefault();

  const role = document.getElementById("loginRole").value;
  const email = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorBox = document.getElementById("loginError");

  try {
    errorBox.textContent = "Signing in...";

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    const { data: staff, error: staffError } = await supabaseClient
      .from("hotel_staff")
      .select("role, hotel_id")
      .eq("user_id", data.user.id)
      .eq("hotel_id", STAFF_HOTEL_ID)
      .maybeSingle();

    if (staffError) throw staffError;

    if (!staff || staff.role !== role) {
      await supabaseClient.auth.signOut();
      throw new Error("Invalid staff role for this hotel.");
    }

    staffUser = data.user;
    staffRole = staff.role;
    sessionStorage.setItem("qd_staff_role", staffRole);

    const target =
      pendingStaffPage || (staffRole === "admin" ? "admin" : "chef");

    closeStaffLogin();
    updateStaffNavigation();

    if (target === "chef") {
      await fetchChefOrders();
      subscribeChefOrders();
    }

    showPage(target);

    toast("Login successful.");
  } catch (error) {
    console.error(error);
    errorBox.textContent = error.message;
  }
}

function updateStaffNavigation() {
  document.querySelectorAll(".protected-nav").forEach((btn) => {
    const allowed =
      btn.dataset.role === "admin"
        ? staffRole === "admin"
        : staffRole === "admin" || staffRole === "chef";

    btn.classList.toggle("hidden", !allowed);
  });

  document.querySelectorAll(".customer-nav,.customer-control").forEach((el) => {
    el.classList.toggle("hidden", staffRole === "chef");
  });

  document
    .getElementById("staffAccessBtn")
    .classList.toggle("hidden", !!staffRole);
  document
    .getElementById("staffLogoutBtn")
    .classList.toggle("hidden", !staffRole);
}

function staffLogout() {
  staffRole = null;
  sessionStorage.removeItem("qd_staff_role");
  updateStaffNavigation();
  showPage("menu");
  toast("Staff logged out.");
}

/* TABLE SELECTION */

function showTableSelection() {
  const modal = document.getElementById("tableSelectionModal");
  if (!modal) return;

  const error = document.getElementById("tableSelectionError");
  if (error) error.textContent = "";

  document.querySelectorAll(".table-choice").forEach((button) => {
    const number = Number(button.dataset.table || button.textContent.trim());
    button.classList.toggle("selected", number === tableNo);
  });

  modal.classList.remove("hidden");
}

function closeTableSelection() {
  document.getElementById("tableSelectionModal")?.classList.add("hidden");
}

async function chooseTable(number) {
  const changed = changeTable(number);
  if (changed === false) return;

  sessionStorage.setItem("qd_selected_table", String(number));
  closeTableSelection();
  await fetchFoods();
}

/* TABLE MANAGEMENT */

function changeTable(value) {
  const next = Number(value);

  if (!Number.isInteger(next) || next < 1 || next > 12) {
    toast("Choose a table from 1 to 12.");
    return false;
  }

  if (
    cart.length &&
    next !== tableNo &&
    !confirm(
      "Changing tables will keep the cart items but assign the order to the new table. Continue?",
    )
  ) {
    return false;
  }

  tableNo = next;
  qrCode = `${HOTEL_CODE}-TABLE${String(tableNo).padStart(2, "0")}`;

  const url = new URL(window.location.href);
  url.searchParams.set("hotel", HOTEL_CODE);
  url.searchParams.set("table", String(tableNo));
  url.searchParams.set("qr", qrCode);

  history.replaceState({}, "", url);

  updateHeader();
  renderCart();

  toast("Table changed to " + String(tableNo).padStart(2, "0") + ".");
  return true;
}

function toggleNav() {
  document.getElementById("nav").classList.toggle("open");
}

function toast(msg) {
  let t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2300);
}

function updateHeader() {
  const tableText = "Table " + String(tableNo).padStart(2, "0");

  const menuTable = document.getElementById("menuTable");
  if (menuTable) menuTable.textContent = "You're ordering at " + tableText;

  const tableLabel = document.getElementById("currentTableLabel");
  if (tableLabel) tableLabel.textContent = String(tableNo).padStart(2, "0");

  const totalCartItems = cart.reduce((s, x) => s + x.qty, 0);
  document.getElementById("cartCount").textContent = totalCartItems;
  const sidebarCount = document.getElementById("sidebarCartCount");
  if (sidebarCount) sidebarCount.textContent = totalCartItems;
}

/* CUSTOMER MENU */

function foodCard(f) {
  return `
 <article class="food-card" onclick="openFoodDetails(${f.id})">
   <img src="${f.image || imageFallback}" alt="${f.name}"
   loading="lazy" decoding="async"
   onerror="this.src='${imageFallback}'">
   <div class="food-body">
     <h3>${f.name}</h3>
     <p>${f.description || ""}</p>
     <div class="food-bottom">
       <span class="price">${money(f.price)}</span>
       <button class="add-btn" onclick="event.stopPropagation(); addToCart(${f.id})">＋ Add</button>
     </div>
   </div>
 </article>`;
}

function renderMenu() {
  updateHeader();

  let available = foods.filter((f) => f.available);
  let special = available.find((f) => f.special) || available[0];

  document.getElementById("specialCard").innerHTML = special
    ? `
 <img src="${special.image || imageFallback}" alt="${special.name}" onerror="this.src='${imageFallback}'">
 <div class="special-info" onclick="openFoodDetails(${special.id})">
   <span class="badge">TODAY'S SPECIAL</span>
   <h3>${special.name}</h3>
   <p>${special.description || ""}</p>
   <div class="special-actions">
     <b class="price">${money(special.price)}</b>
     <button class="add-btn" onclick="event.stopPropagation(); addToCart(${special.id})">＋ Add to cart</button>
   </div>
 </div>`
    : "<p>No special available today.</p>";

  const specialImg = document.querySelector("#specialCard img");
  if (specialImg && special) {
    specialImg.onclick = () => openFoodDetails(special.id);
  }

  let counts = {};

  orders.forEach((o) => {
    o.items.forEach((i) => {
      counts[i.id] = (counts[i.id] || 0) + i.qty;
    });
  });

  let popular = available
    .slice()
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0))
    .slice(0, 3);

  document.getElementById("popularList").innerHTML =
    popular.map(foodCard).join("") ||
    "<p>No popular dishes yet. Place the first order!</p>";

  let cats = ["All", ...new Set(available.map((f) => f.category))];

  document.getElementById("categoryFilters").innerHTML = cats
    .map(
      (c) => `
 <button class="filter ${activeCategory === c ? "active" : ""}"
 onclick="setCategory('${c.replace(/'/g, "\\'")}')">
 ${c}</button>`,
    )
    .join("");

  const search = (
    document.getElementById("menuSearch")?.value || ""
  ).trim().toLowerCase();

  const list = available.filter((f) => {
    const matchesCategory =
      activeCategory === "All" || f.category === activeCategory;

    const searchableText = [
      f.name,
      f.description || "",
      f.category || "",
    ].join(" ").toLowerCase();

    return matchesCategory && searchableText.includes(search);
  });

  document.getElementById("menuList").innerHTML = list.length
    ? list.map(foodCard).join("")
    : `<div class="menu-empty-state">
         <div class="menu-empty-icon">🔎</div>
         <h3>No dishes found</h3>
         <p>Try another dish name or choose a different category.</p>
       </div>`;

  renderCart();
}

function setCategory(c) {
  activeCategory = c;
  renderMenu();
}

/* FOOD ITEM DETAILS MODAL */

function openFoodDetails(id) {
  const food = foods.find((x) => x.id === id);
  if (!food) return;

  activeModalFoodId = food.id;
  modalFoodQty = 1;

  const img = document.getElementById("foodModalImage");
  img.src = food.image || imageFallback;
  img.alt = food.name;

  const specialBadge = document.getElementById("foodModalSpecial");
  specialBadge.classList.toggle("hidden", !food.special);

  document.getElementById("foodModalCategory").textContent =
    food.category || "Menu Item";
  document.getElementById("foodModalTime").textContent =
    `⏱ ${food.time || 15} mins prep`;
  document.getElementById("foodModalTitle").textContent = food.name;
  document.getElementById("foodModalPrice").textContent = money(food.price);
  document.getElementById("foodModalDescription").textContent =
    food.description || "Freshly prepared to order.";

  const ingredientsBox = document.getElementById("foodModalIngredients");
  const ingredients = Array.isArray(food.ingredients) ? food.ingredients : [];
  ingredientsBox.innerHTML = ingredients.length
    ? ingredients
        .map((ing) => `<span class="ingredient-tag">${adminEscape(ing)}</span>`)
        .join("")
    : '<span class="muted">Fresh house ingredients</span>';

  updateFoodModalControls(food);
  document.getElementById("foodDetailsModal").classList.remove("hidden");
}

function closeFoodDetails() {
  document.getElementById("foodDetailsModal")?.classList.add("hidden");
  activeModalFoodId = null;
  modalFoodQty = 1;
}

function updateFoodModalControls(food) {
  document.getElementById("foodModalQty").textContent = modalFoodQty;
  const total = Number(food.price || 0) * modalFoodQty;
  document.getElementById("foodModalAddBtn").textContent =
    `Add to Cart · ${money(total)}`;
}

function changeModalQty(delta) {
  const food = foods.find((x) => x.id === activeModalFoodId);
  if (!food) return;

  modalFoodQty = Math.min(20, Math.max(1, modalFoodQty + delta));
  updateFoodModalControls(food);
}

function addModalFoodToCart() {
  if (!activeModalFoodId) return;
  const food = foods.find((x) => x.id === activeModalFoodId);
  if (!food || !food.available) return;

  const qtyToAdd = modalFoodQty;
  addToCart(food.id, qtyToAdd);
  closeFoodDetails();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeFoodDetails();
    closeTableSelection();
    closeStaffLogin();
  }
});

/* CART */

function addToCart(id, qty = 1) {
  let f = foods.find((x) => x.id === id);
  if (!f || !f.available) return;

  const amount = Math.max(1, Number(qty) || 1);
  let item = cart.find((x) => x.id === id);

  if (item) item.qty += amount;
  else
    cart.push({
      id: f.id,
      name: f.name,
      price: f.price,
      time: f.time,
      image: f.image,
      qty: amount,
    });

  save("qd_cart", cart);
  renderCart();
  updateHeader();
  toast(
    amount > 1
      ? `${amount} × ${f.name} added to cart`
      : `${f.name} added to cart`,
  );
}

function changeQty(id, delta) {
  let item = cart.find((x) => x.id === id);
  if (!item) return;

  item.qty += delta;

  if (item.qty <= 0) {
    cart = cart.filter((x) => x.id !== id);
  }

  save("qd_cart", cart);
  renderCart();
  updateHeader();
}

function removeCart(id) {
  cart = cart.filter((x) => x.id !== id);
  save("qd_cart", cart);
  renderCart();
  updateHeader();
}

function cartSubtotal() {
  return cart.reduce((s, i) => s + i.price * i.qty, 0);
}

function renderCart() {
  updateHeader();

  document.getElementById("cartTableText").textContent =
    "Table " + String(tableNo).padStart(2, "0");

  document.getElementById("cartItems").innerHTML = cart.length
    ? cart
        .map(
          (i) => `
 <div class="cart-row">
   <img src="${i.image || imageFallback}" onerror="this.src='${imageFallback}'">
   <div class="cart-info">
     <h3>${i.name}</h3>
     <p>${money(i.price)} each · ${i.time} min preparation</p>
     <div class="qty">
       <button onclick="changeQty(${i.id},-1)">−</button>
       <b>${i.qty}</b>
       <button onclick="changeQty(${i.id},1)">+</button>
       <button class="remove" onclick="removeCart(${i.id})">Remove</button>
     </div>
     <div class="prep">Estimated item time: ${i.time} minutes</div>
   </div>
   <b>${money(i.price * i.qty)}</b>
 </div>`,
        )
        .join("")
    : `<div class="empty-cart">
    <div class="empty-cart-icon">🛒</div>
    <h3>Your cart is empty</h3>
    <p class="muted">Add dishes from the menu and they will appear here.</p>
  </div>`;

  document.getElementById("cartSubtotal").textContent = money(cartSubtotal());
  document.getElementById("cartTotal").textContent = money(cartSubtotal());

  document.getElementById("cartPrep").textContent = cart.length
    ? Math.max(...cart.map((i) => i.time)) + " min max"
    : "—";
}

/* ORDER PLACEMENT */

async function placeOrder() {
  if (!cart.length) {
    toast("Please add items before placing an order.");
    return;
  }

  const requestId = crypto.randomUUID();
  const { data, error } = await supabaseClient.rpc("place_order", {
    p_qr_code: qrCode,
    p_items: cart.map((item) => ({ id: item.id, qty: item.qty })),
    p_request_id: requestId,
  });

  if (error) {
    console.error("Order error:", error);
    toast("Unable to place order. Check the QR code and try again.");
    return;
  }

  const newOrder = {
    id: data.order_id,
    orderNumber: data.order_number,
    table: tableNo,
    items: cart.map((item) => ({
      ...item,
      status: "Pending",
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "Pending",
    paid: false,
    trackingToken: data.tracking_token,
  };

  orders.push(newOrder);

  currentOrderId = data.order_id;
  save("qd_currentOrder", currentOrderId);

  if (data.tracking_token && !trackingTokens.includes(data.tracking_token)) {
    trackingTokens.push(data.tracking_token);
  }

  save("qd_trackingTokens", trackingTokens);

  cart = [];
  save("qd_cart", cart);
  renderCart();
  updateHeader();

  toast("Order placed successfully!");
  showPage("waiting");
}

function getCurrentOrder() {
  return (
    trackedOrders.find((o) => o.id === currentOrderId) ||
    orders.find((o) => o.id === currentOrderId) ||
    orders.filter((o) => o.table === tableNo).slice(-1)[0]
  );
}

function overallStatus(o) {
  if (o.items.every((i) => i.status === "Served")) return "Served";
  if (o.items.some((i) => i.status === "Preparing")) return "Preparing";
  if (o.items.some((i) => i.status === "Ready")) return "Ready";

  return "Pending";
}

/* WAITING PAGE */

async function renderWaiting() {
  const box = document.getElementById("waitingContent");

  if (!trackingTokens.length) {
    box.innerHTML = `
      <div class="summary-card">
        <h2>No orders found</h2>
        <p class="muted">Place an order to track it here.</p>
        <button class="primary" onclick="showPage('menu')">
          Go to menu
        </button>
      </div>`;
    return;
  }

  trackedOrders = [];

  for (const token of trackingTokens) {
    const { data, error } = await supabaseClient.rpc("get_customer_order", {
      p_tracking_token: token,
    });

    if (error) {
      console.error("Order tracking error:", error);
      continue;
    }

    if (!data || !data.order) continue;

    const order = {
      id: data.order.id,
      orderNumber: data.order.order_number,
      table: data.order.table_number,
      status: data.order.status,
      paid: data.order.is_paid,
      trackingToken: token,
      items: (data.items || []).map((item) => ({
        id: item.food_id,
        name: item.food_name,
        price: Number(item.price),
        qty: item.quantity,
        time: item.preparation_time,
        status: item.status,
      })),
    };

    trackedOrders.push(order);
  }

  if (!trackedOrders.length) {
    box.innerHTML = `
      <div class="summary-card">
        <h2>Unable to retrieve orders</h2>
        <p class="muted">
          Please check your connection and refresh.
        </p>
      </div>`;
    return;
  }

  const latest = trackedOrders[trackedOrders.length - 1];

  orders = trackedOrders;
  currentOrderId = latest.id;

  box.innerHTML = trackedOrders
    .slice()
    .reverse()
    .map((order) => {
      const maxTime = order.items.reduce(
        (max, item) => Math.max(max, item.time || 0),
        0,
      );

      return `
        <div class="summary-card">
          <div class="order-head">
            <div>
              <span class="eyebrow">
                ORDER ${order.orderNumber}
              </span>
              <h2>Table ${String(order.table).padStart(2, "0")}</h2>
            </div>
            <span class="status ${order.status}">${order.status}</span>
          </div>

          <p class="muted">
            Estimated preparation time: up to ${maxTime} minutes.
          </p>

          ${order.items
            .map(
              (item) => `
            <div class="order-item">
              <div>
                <b>${item.name} × ${item.qty}</b>
                <div class="tiny">
                  ${item.time} min estimate
                </div>
              </div>
              <span class="status ${item.status}">
                ${item.status}
              </span>
            </div>
          `,
            )
            .join("")}

          <p class="muted">
            ${order.paid ? "Payment completed" : "Payment pending"}
          </p>

          <button class="primary"
            onclick="trackOrderPayment(${order.id})">
            View payment
          </button>
        </div>
      `;
    })
    .join("");
}

function startCustomerTracking() {
  if (customerTrackingTimer) {
    clearInterval(customerTrackingTimer);
  }

  customerTrackingTimer = setInterval(async () => {
    if (document.hidden) return;

    await renderWaiting();
  }, 3000);
}

function stopCustomerTracking() {
  if (customerTrackingTimer) {
    clearInterval(customerTrackingTimer);
    customerTrackingTimer = null;
  }
}

function trackOrderPayment(orderId) {
  const order = trackedOrders.find((o) => o.id === orderId);

  if (!order) return;

  currentOrderId = order.id;
  save("qd_currentOrder", currentOrderId);

  showPage("payment");
}

function reorder() {
  let o = getCurrentOrder();
  if (!o) return;

  cart = o.items.map((i) => ({
    id: i.id,
    name: i.name,
    price: i.price,
    time: i.time,
    image: i.image,
    qty: i.qty,
  }));

  save("qd_cart", cart);
  showPage("menu");
  toast("Previous items added to your cart.");
}

/* PAYMENT */

function getBillOrder() {
  return getCurrentOrder();
}

function updatePayment() {
  let o = getBillOrder();
  let items = o ? o.items : [];
  let food = items.reduce((s, i) => s + i.price * i.qty, 0);
  let gst = food * 0.05;
  let discount = food * discountRate;
  let total = Math.max(0, food + gst - discount);

  document.getElementById("billItems").innerHTML = items.length
    ? items
        .map(
          (i) => `
 <div class="summary-line">
   <span>${i.name} × ${i.qty}</span>
   <b>${money(i.price * i.qty)}</b>
 </div>`,
        )
        .join("")
    : "<p class='muted'>No order to bill yet.</p>";

  document.getElementById("foodBill").textContent = money(food);
  document.getElementById("gstAmount").textContent = money(gst);
  document.getElementById("discountAmount").textContent =
    "- " + money(discount);
  document.getElementById("grandTotal").textContent = money(total);

  let split = document.getElementById("splitToggle").checked;

  document.getElementById("splitControls").classList.toggle("hidden", !split);

  let n = Math.max(2, Number(document.getElementById("splitCount").value) || 2);

  document.getElementById("splitAmount").textContent =
    "Each person pays: " + money(total / n);

  return { food, gst, discount, total };
}

function applyDiscount() {
  let code = document.getElementById("discountCode").value.trim().toUpperCase();

  if (code === "DINE10") {
    discountRate = 0.1;
    document.getElementById("discountMessage").textContent =
      "10% discount applied!";
  } else {
    discountRate = 0;
    document.getElementById("discountMessage").textContent =
      "Invalid coupon. Try DINE10.";
  }

  updatePayment();
}

let paymentRedirectTimer = null;

function completePayment() {
  let o = getBillOrder();

  if (!o) {
    toast("No order available for payment.");
    return;
  }

  let bill = updatePayment();
  let mode = document.querySelector('input[name="paymode"]:checked').value;

  const paymentTime = new Date();

  o.paid = true;
  o.paymentMode = mode;
  o.paidAmount = bill.total;
  o.paidAt = paymentTime.toISOString();
  o.updatedAt = paymentTime.toISOString();

  // Clear active order & coupon so a new order starts clean
  currentOrderId = null;
  save("qd_currentOrder", null);
  discountRate = 0;

  persist();

  let greeting = document.getElementById("paymentGreeting");

  greeting.classList.remove("hidden");

  greeting.innerHTML = `
    <h2>Thank you for dining with QR Dine! 🎉</h2>
    <p>Payment: ${money(bill.total)}</p>
    <p>Payment Mode: ${mode}</p>
    <p>Payment Time: ${paymentTime.toLocaleString("en-IN")}</p>
    <p class="muted">Returning to the menu in 3 seconds...</p>
    <button type="button" class="primary" onclick="returnToMenuAfterPayment()">Back to Menu Now</button>
  `;

  toast("Payment completed! Returning to menu...");

  if (paymentRedirectTimer) clearTimeout(paymentRedirectTimer);
  paymentRedirectTimer = setTimeout(() => {
    returnToMenuAfterPayment();
  }, 3000);
}

function returnToMenuAfterPayment() {
  if (paymentRedirectTimer) {
    clearTimeout(paymentRedirectTimer);
    paymentRedirectTimer = null;
  }

  const greeting = document.getElementById("paymentGreeting");
  if (greeting) greeting.classList.add("hidden");

  const codeInput = document.getElementById("discountCode");
  const codeMsg = document.getElementById("discountMessage");
  if (codeInput) codeInput.value = "";
  if (codeMsg) codeMsg.textContent = "";

  showPage("menu");
}

/* UNIQUE HOTEL QR CODE GENERATOR */

let adminQrInstance = null;

function getDefaultBaseUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function initAdminQrGenerator() {
  const input = document.getElementById("qrBaseUrlInput");
  if (!input) return;

  if (!input.value.trim()) {
    const savedBase = localStorage.getItem("qd_admin_qr_base_url");
    input.value = savedBase || getDefaultBaseUrl();
  }

  renderAdminQr();
}

function buildAdminQrPayload() {
  const input = document.getElementById("qrBaseUrlInput");
  const rawBase = (input?.value || "").trim() || getDefaultBaseUrl();

  if (input && input.value.trim()) {
    localStorage.setItem("qd_admin_qr_base_url", input.value.trim());
  }

  let finalUrl;
  try {
    const parsed = new URL(rawBase);
    parsed.search = "";
    parsed.hash = "";
    parsed.searchParams.set("hotel", HOTEL_CODE);
    finalUrl = parsed.toString();
  } catch {
    finalUrl = rawBase;
  }

  return finalUrl;
}

function renderAdminQr() {
  const box = document.getElementById("adminQrCanvas");
  if (!box) return;

  const finalUrl = buildAdminQrPayload();

  const urlCode = document.getElementById("qrEncodedUrl");
  if (urlCode) urlCode.textContent = finalUrl;

  const titleEl = document.getElementById("qrCardTitle");
  const subEl = document.getElementById("qrCardSubtitle");
  if (titleEl) titleEl.textContent = HOTEL_NAME;
  if (subEl) subEl.textContent = "Scan & select your table (01–12)";

  const warning = document.getElementById("qrLocalhostWarning");
  if (warning) {
    const isLocal =
      finalUrl.startsWith("file:") ||
      finalUrl.includes("localhost") ||
      finalUrl.includes("127.0.0.1");
    warning.classList.toggle("hidden", !isLocal);
  }

  box.innerHTML = "";
  if (typeof window.QRCode === "function") {
    adminQrInstance = new window.QRCode(box, {
      text: finalUrl,
      width: 176,
      height: 176,
      colorDark: "#20251f",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  } else {
    box.innerHTML = '<p class="tiny muted">QR library unavailable offline.</p>';
  }
}

function downloadAdminQr() {
  const box = document.getElementById("adminQrCanvas");
  if (!box) return;

  const sourceCanvas = box.querySelector("canvas");
  const sourceImg = box.querySelector("img");

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = 440;
  exportCanvas.height = 540;
  const ctx = exportCanvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

  ctx.strokeStyle = "#245c43";
  ctx.lineWidth = 8;
  ctx.strokeRect(16, 16, exportCanvas.width - 32, exportCanvas.height - 32);

  ctx.fillStyle = "#245c43";
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("SCAN TO ORDER", exportCanvas.width / 2, 66);

  const drawFrame = (drawable) => {
    ctx.drawImage(drawable, 70, 92, 300, 300);

    ctx.fillStyle = "#20251f";
    ctx.font = "bold 24px sans-serif";
    ctx.fillText(HOTEL_NAME, exportCanvas.width / 2, 438);

    ctx.fillStyle = "#72786f";
    ctx.font = "16px sans-serif";
    ctx.fillText("Scan & select your table (01–12)", exportCanvas.width / 2, 472);

    const link = document.createElement("a");
    link.download = `${HOTEL_CODE}_QR_Dine_Poster.png`;
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
    toast("Hotel QR code PNG downloaded.");
  };

  if (sourceCanvas) {
    drawFrame(sourceCanvas);
  } else if (sourceImg && sourceImg.src) {
    const img = new Image();
    img.onload = () => drawFrame(img);
    img.src = sourceImg.src;
  } else {
    toast("QR code not ready yet.");
  }
}

function printAdminQr() {
  window.print();
}

async function copyAdminQrLink() {
  const finalUrl = buildAdminQrPayload();
  try {
    await navigator.clipboard.writeText(finalUrl);
    toast("Hotel QR URL copied to clipboard.");
  } catch {
    prompt("Copy this Hotel QR URL:", finalUrl);
  }
}

/* ADMIN DASHBOARD - LIVE SUPABASE DATA */

function adminEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function adminOrderIsActive(order) {
  const status = String(order.status || "Pending").toLowerCase();
  return !["served", "completed", "cancelled", "canceled"].includes(status);
}

async function fetchAdminDashboard() {
  if (staffRole !== "admin") return;

  initAdminQrGenerator();

  const statsBox = document.getElementById("adminStats");
  const tablesBox = document.getElementById("tableOrders");
  const countLabel = document.getElementById("adminOrderCount");
  const updatedLabel = document.getElementById("adminUpdatedAt");

  statsBox.innerHTML = '<div class="stat"><small>Dashboard</small><b>Loading…</b></div>';
  tablesBox.innerHTML = '<div class="admin-empty">Fetching the latest restaurant orders…</div>';
  countLabel.textContent = "Loading orders…";

  try {
    const { data: orderRows, error: orderError } = await supabaseClient
      .from("orders")
      .select("id, order_number, table_number, status, total_amount, is_paid, created_at, hotel_id")
      .eq("hotel_id", STAFF_HOTEL_ID)
      .order("created_at", { ascending: false })
      .limit(200);

    if (orderError) throw orderError;

    const orderIds = (orderRows || []).map((order) => order.id);
    let itemRows = [];

    if (orderIds.length) {
      const { data, error } = await supabaseClient
        .from("order_items")
        .select("id, order_id, food_name, quantity, status")
        .in("order_id", orderIds);
      if (error) throw error;
      itemRows = data || [];
    }

    const itemsByOrder = {};
    itemRows.forEach((item) => {
      (itemsByOrder[item.order_id] ||= []).push(item);
    });

    const rows = orderRows || [];
    const activeOrders = rows.filter(adminOrderIsActive);
    const paidOrders = rows.filter((order) => order.is_paid === true);
    const revenue = paidOrders.reduce((sum, order) => sum + Number(order.total_amount || 0), 0);
    const activeTables = new Set(activeOrders.map((order) => Number(order.table_number))).size;

    const metrics = [
      ["Total orders", rows.length, "All recorded orders"],
      ["Active orders", activeOrders.length, "Not yet completed"],
      ["Paid orders", paidOrders.length, "Payments recorded"],
      ["Active tables", activeTables, "Tables with active orders"],
      ["Recorded revenue", money(revenue), "From paid orders"],
    ];

    statsBox.innerHTML = metrics.map(([label, value, hint]) => `
      <div class="stat admin-stat-card">
        <small>${label}</small>
        <b>${value}</b>
        <span>${hint}</span>
      </div>`).join("");

    countLabel.textContent = `${rows.length} order(s) loaded`;
    updatedLabel.textContent = `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;

    if (!rows.length) {
      tablesBox.innerHTML = '<div class="admin-empty"><div>🍽️</div><h3>No orders yet</h3><p>Customer orders will appear here as soon as they are placed.</p></div>';
      return;
    }

    const tableNumbers = [...new Set(rows.map((order) => Number(order.table_number)))].sort((a, b) => a - b);
    tablesBox.innerHTML = tableNumbers.map((tableNumber) => {
      const tableOrders = rows.filter((order) => Number(order.table_number) === tableNumber);
      const hasActive = tableOrders.some(adminOrderIsActive);
      const orderMarkup = tableOrders.map((order) => {
        const orderItems = itemsByOrder[order.id] || [];
        const orderStatus = order.status || (order.is_paid ? "Paid" : "Pending");
        const orderLabel = order.order_number || order.id;
        const created = order.created_at
          ? new Date(order.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
          : "Time unavailable";
        const itemsMarkup = orderItems.length
          ? orderItems.map((item) => `
              <div class="admin-order-item">
                <span>${adminEscape(item.food_name)} <b>× ${Number(item.quantity || 0)}</b></span>
                <span class="status ${adminEscape(item.status || "Pending")}">${adminEscape(item.status || "Pending")}</span>
              </div>`).join("")
          : '<p class="muted admin-no-items">Item details unavailable for this order.</p>';
        return `
          <div class="admin-order-block">
            <div class="admin-order-heading">
              <div><b>Order ${adminEscape(orderLabel)}</b><small>${created}</small></div>
              <span class="status ${adminEscape(orderStatus)}">${adminEscape(orderStatus)}</span>
            </div>
            ${itemsMarkup}
            <div class="admin-order-total"><span>${order.is_paid ? "Paid" : "Unpaid"}</span><b>${money(order.total_amount)}</b></div>
          </div>`;
      }).join("");

      return `
        <article class="table-card admin-table-card">
          <div class="admin-table-heading">
            <div><p class="eyebrow">DINING TABLE</p><h3>Table ${String(tableNumber).padStart(2, "0")}</h3></div>
            <span class="status ${hasActive ? "Preparing" : "Served"}">${hasActive ? "Active" : "Completed"}</span>
          </div>
          <p class="muted admin-table-meta">${tableOrders.length} order(s)</p>
          ${orderMarkup}
        </article>`;
    }).join("");
  } catch (error) {
    console.error("Admin dashboard loading error:", error);
    statsBox.innerHTML = '<div class="admin-empty admin-error">Could not load dashboard statistics.</div>';
    tablesBox.innerHTML = `<div class="admin-empty admin-error"><h3>Unable to load orders</h3><p>${adminEscape(error.message || "Check your Supabase connection and staff permissions.")}</p><button class="secondary" onclick="fetchAdminDashboard()">Try again</button></div>`;
    countLabel.textContent = "Orders unavailable";
    toast("Could not load admin dashboard.");
  }
}

/* CHEF DASHBOARD - SUPABASE */

async function fetchChefOrders() {
  if (!staffRole) return;

  const { data: orderRows, error: orderError } = await supabaseClient
    .from("orders")
    .select("id, order_number, table_number, status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (orderError) {
    console.error(orderError);
    toast("Could not load kitchen orders.");
    return;
  }

  const orderIds = (orderRows || []).map((o) => o.id);

  if (!orderIds.length) {
    chefOrders = [];
    renderChef();
    return;
  }

  const { data: itemRows, error: itemError } = await supabaseClient
    .from("order_items")
    .select("*")
    .in("order_id", orderIds)
    .order("id");

  if (itemError) {
    console.error(itemError);
    toast("Could not load order items.");
    return;
  }

  chefOrders = orderRows
    .map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      table: order.table_number,
      status: order.status,
      items: (itemRows || [])
        .filter((item) => item.order_id === order.id)
        .map((item) => ({
          id: item.id,
          name: item.food_name,
          qty: item.quantity,
          time: item.preparation_time,
          status: item.status,
        })),
    }))
    .filter((order) => order.items.length > 0);

  renderChef();
}

function subscribeChefOrders() {
  if (chefOrdersChannel) {
    supabaseClient.removeChannel(chefOrdersChannel);
    chefOrdersChannel = null;
  }

  chefOrdersChannel = supabaseClient
    .channel("kitchen-live-orders")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "orders",
      },
      async (payload) => {
        console.log("NEW ORDER EVENT:", payload);
        await fetchChefOrders();
      },
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "order_items",
      },
      async (payload) => {
        console.log("ORDER ITEM EVENT:", payload);
        await fetchChefOrders();
      },
    )
    .subscribe((status, error) => {
      console.log("Kitchen Realtime:", status);

      if (error) {
        console.error("Realtime error:", error);
      }
    });
}

function renderChef() {
  const activeOrders = chefOrders.filter((order) =>
    order.items.some((item) => item.status !== "Served"),
  );

  document.getElementById("chefOrders").innerHTML = activeOrders.length
    ? activeOrders
        .map(
          (order) => `
        <div class="order-card">
          <div class="order-head">
            <div>
              <span class="eyebrow">${order.orderNumber}</span>
              <h2>Table ${String(order.table).padStart(2, "0")}</h2>
            </div>
            <span class="status">${overallStatus(order)}</span>
          </div>

          ${order.items
            .map(
              (item) => `
            <div class="order-item">
              <div>
                <b>${item.name} × ${item.qty}</b>
                <div class="tiny">
                  ${item.time} min estimate
                </div>
              </div>

              <div class="status-buttons">
  ${statusOptions
    .map(
      (status) => `
    <button
      class="status-btn ${item.status === status ? "active" : ""}"
      onclick="setItemStatus(${item.id}, '${status}')"
      ${item.status === status ? "disabled" : ""}>
      ${status}
    </button>
  `,
    )
    .join("")}
</div>
            </div>
          `,
            )
            .join("")}
        </div>
      `,
        )
        .join("")
    : `
        <div class="summary-card">
          <h2>No active kitchen orders</h2>
          <p class="muted">New customer orders will appear here.</p>
        </div>
      `;
}

async function setItemStatus(itemId, status) {
  if (!statusOptions.includes(status)) return;

  const { error } = await supabaseClient
    .from("order_items")
    .update({ status: status })
    .eq("id", itemId);

  if (error) {
    console.error(error);
    toast("Unable to update item status.");
    return;
  }

  toast("Food status updated.");

  await fetchChefOrders();
}

/* ANALYTICS */

function renderAnalytics() {
  let counts = {};

  orders.forEach((o) => {
    o.items.forEach((i) => {
      counts[i.id] = (counts[i.id] || 0) + i.qty;
    });
  });

  let ranked = foods
    .map((f) => ({
      ...f,
      sold: counts[f.id] || 0,
    }))
    .sort((a, b) => b.sold - a.sold);

  let revenue = orders
    .filter((o) => o.paid)
    .reduce((s, o) => s + (o.paidAmount || 0), 0);

  let units = Object.values(counts).reduce((a, b) => a + b, 0);

  document.getElementById("analyticsStats").innerHTML = [
    ["Total orders", orders.length],
    ["Items sold", units],
    ["Paid revenue", money(revenue)],
    ["Menu items", foods.length],
  ]
    .map(
      (x) => `
 <div class="stat">
   <small>${x[0]}</small>
   <b>${x[1]}</b>
 </div>`,
    )
    .join("");

  const bars = (arr) =>
    arr
      .map(
        (f) => `
 <div class="bar-row">
   <span>${f.name}</span>
   <div class="bar">
     <span style="width:${Math.max(2, (f.sold / (ranked[0]?.sold || 1)) * 100)}%"></span>
   </div>
   <b>${f.sold}</b>
 </div>`,
      )
      .join("") || "<p class='muted'>No sales data yet.</p>";

  document.getElementById("topItems").innerHTML = bars(ranked.slice(0, 5));

  document.getElementById("lowItems").innerHTML = bars(
    ranked
      .slice()
      .sort((a, b) => a.sold - b.sold)
      .slice(0, 5),
  );

  let ingredients = {};

  ranked.forEach((f) =>
    (f.ingredients || []).forEach((ing) => {
      ingredients[ing] = (ingredients[ing] || 0) + f.sold;
    }),
  );

  document.getElementById("ingredientList").innerHTML = Object.keys(ingredients)
    .length
    ? Object.entries(ingredients)
        .sort((a, b) => b[1] - a[1])
        .map(
          ([n, v]) => `
 <div class="summary-line">
   <span>${n}</span>
   <b>Plan stock for at least ${Math.max(5, v + 3)} units</b>
 </div>`,
        )
        .join("")
    : "<p class='muted'>Ingredient suggestions appear after orders are recorded.</p>";

  let special = foods.find((f) => f.special);

  document.getElementById("specialAdmin").innerHTML = `
 <p>${special ? special.name : "No special selected"}</p>
 <button class="secondary" onclick="chooseSpecial()">Change today's special</button>`;

  document.getElementById("manageMenu").innerHTML = foods
    .map(
      (f) => `
 <tr>
   <td><b>${f.name}</b></td>
   <td>${money(f.price)}</td>
   <td>${f.category}</td>
   <td>${f.available ? "Available" : "Finished"}</td>
   <td>
     <button class="secondary" onclick="editFood(${f.id})">Edit</button>
     <button class="secondary" onclick="toggleFood(${f.id})">
       ${f.available ? "Mark finished" : "Restore"}
     </button>
     <button class="secondary danger-action" onclick="deleteFood(${f.id})">Delete</button>
   </td>
 </tr>`,
    )
    .join("");
}

/* MENU MANAGEMENT & IMAGE UPLOAD */

function handleFoodImageSelect(event) {
  const file = event.target.files?.[0];
  const hint = document.getElementById("foodImageFileHint");
  const preview = document.getElementById("foodImagePreview");

  if (selectedFoodPreviewUrl) {
    URL.revokeObjectURL(selectedFoodPreviewUrl);
    selectedFoodPreviewUrl = null;
  }

  if (!file) {
    selectedFoodImageFile = null;
    if (hint) hint.textContent = "Choose a photo from your phone or PC (JPG, PNG, WebP).";
    syncPreviewFromUrl();
    return;
  }

  if (!file.type.startsWith("image/")) {
    toast("Please select a valid image file.");
    event.target.value = "";
    selectedFoodImageFile = null;
    return;
  }

  selectedFoodImageFile = file;
  selectedFoodPreviewUrl = URL.createObjectURL(file);
  if (preview) preview.src = selectedFoodPreviewUrl;
  if (hint) {
    const sizeKb = Math.round(file.size / 1024);
    hint.textContent = `Selected: ${file.name} (${sizeKb} KB — will auto-compress on save)`;
  }
}

function syncPreviewFromUrl() {
  if (selectedFoodImageFile) return;
  const preview = document.getElementById("foodImagePreview");
  const urlVal = document.getElementById("foodImage")?.value.trim();
  if (preview) {
    preview.src = urlVal || imageFallback;
  }
}

function compressFoodImage(file, maxWidth = 800, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let width = img.width;
      let height = img.height;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Image compression failed."));
            return;
          }
          resolve(blob);
        },
        "image/jpeg",
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read the selected image file."));
    };

    img.src = objectUrl;
  });
}

async function uploadDishPhotoToSupabase(file, dishName) {
  const compressedBlob = await compressFoodImage(file);
  const safeSlug = (dishName || "dish")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "dish";
  const filePath = `hotel-${STAFF_HOTEL_ID}/${Date.now()}-${safeSlug}.jpg`;

  const { error: uploadError } = await supabaseClient.storage
    .from(MENU_IMAGES_BUCKET)
    .upload(filePath, compressedBlob, {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (uploadError) throw uploadError;

  const { data } = supabaseClient.storage
    .from(MENU_IMAGES_BUCKET)
    .getPublicUrl(filePath);

  return data.publicUrl;
}

function openAddFood() {
  clearFoodForm();
  document.getElementById("editorTitle").textContent = "Add menu item";
  document.getElementById("foodName").focus();
}

function clearFoodForm() {
  [
    "foodId",
    "foodName",
    "foodPrice",
    "foodCategory",
    "foodImage",
    "foodDescription",
    "foodIngredients",
  ].forEach((id) => {
    document.getElementById(id).value = "";
  });

  document.getElementById("foodTime").value = 15;

  if (selectedFoodPreviewUrl) {
    URL.revokeObjectURL(selectedFoodPreviewUrl);
    selectedFoodPreviewUrl = null;
  }
  selectedFoodImageFile = null;

  const fileInput = document.getElementById("foodImageFile");
  if (fileInput) fileInput.value = "";

  const hint = document.getElementById("foodImageFileHint");
  if (hint) hint.textContent = "Choose a photo from your phone or PC (JPG, PNG, WebP).";

  const preview = document.getElementById("foodImagePreview");
  if (preview) preview.src = imageFallback;
}

function editFood(id) {
  let f = foods.find((x) => x.id === id);
  if (!f) return;

  if (selectedFoodPreviewUrl) {
    URL.revokeObjectURL(selectedFoodPreviewUrl);
    selectedFoodPreviewUrl = null;
  }
  selectedFoodImageFile = null;

  const fileInput = document.getElementById("foodImageFile");
  if (fileInput) fileInput.value = "";

  const hint = document.getElementById("foodImageFileHint");
  if (hint) hint.textContent = "Upload a new photo to replace the current image, or leave blank to keep it.";

  document.getElementById("foodId").value = f.id;
  document.getElementById("foodName").value = f.name;
  document.getElementById("foodPrice").value = f.price;
  document.getElementById("foodCategory").value = f.category;
  document.getElementById("foodTime").value = f.time;
  document.getElementById("foodImage").value = f.image;
  document.getElementById("foodDescription").value = f.description;
  document.getElementById("foodIngredients").value = (f.ingredients || []).join(
    ", ",
  );

  const preview = document.getElementById("foodImagePreview");
  if (preview) preview.src = f.image || imageFallback;

  document.getElementById("editorTitle").textContent = "Edit " + f.name;

  document.querySelector(".editor").scrollIntoView({ behavior: "smooth" });
}

async function saveFood() {
  if (staffRole !== "admin") {
    toast("Only an admin can manage menu items.");
    return;
  }

  const name = document.getElementById("foodName").value.trim();
  const price = Number(document.getElementById("foodPrice").value);
  const category = document.getElementById("foodCategory").value.trim();
  const time = Number(document.getElementById("foodTime").value) || 15;
  const id = Number(document.getElementById("foodId").value);

  if (!name || !Number.isFinite(price) || price <= 0 || !category || time <= 0) {
    toast("Enter a food name, valid price, category and preparation time.");
    return;
  }

  const saveButton = document.querySelector(".editor-actions .primary");
  saveButton.disabled = true;
  saveButton.textContent = selectedFoodImageFile ? "Uploading photo..." : "Saving...";

  try {
    let imageUrl = document.getElementById("foodImage").value.trim() || imageFallback;

    if (selectedFoodImageFile) {
      imageUrl = await uploadDishPhotoToSupabase(selectedFoodImageFile, name);
      saveButton.textContent = "Saving item...";
    }

    const payload = {
      name,
      price,
      category,
      preparation_time: time,
      image: imageUrl,
      description: document.getElementById("foodDescription").value.trim(),
      ingredients: document
        .getElementById("foodIngredients")
        .value.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    };

    let result;
    if (id) {
      result = await supabaseClient
        .from("foods")
        .update(payload)
        .eq("id", id)
        .eq("hotel_id", STAFF_HOTEL_ID);
    } else {
      result = await supabaseClient
        .from("foods")
        .insert({ ...payload, hotel_id: STAFF_HOTEL_ID });
    }

    if (result.error) throw result.error;

    await fetchFoods();
    renderAnalytics();
    clearFoodForm();
    toast(id ? "Food item updated in the database." : "Food item added to the database.");
  } catch (error) {
    console.error("Menu save error:", error);
    toast("Could not save item: " + (error.message || "Check storage bucket and RLS policies."));
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save item";
  }
}

async function toggleFood(id) {
  if (staffRole !== "admin") {
    toast("Only an admin can manage menu items.");
    return;
  }

  const food = foods.find((item) => item.id === id);
  if (!food) return;

  const nextAvailable = !food.available;
  const { error } = await supabaseClient
    .from("foods")
    .update({ available: nextAvailable })
    .eq("id", id)
    .eq("hotel_id", STAFF_HOTEL_ID);

  if (error) {
    console.error("Availability update error:", error);
    toast("Could not update availability: " + error.message);
    return;
  }

  await fetchFoods();
  renderAnalytics();
  toast(nextAvailable ? "Item restored." : "Item marked as finished.");
}

async function deleteFood(id) {
  if (staffRole !== "admin") {
    toast("Only an admin can delete menu items.");
    return;
  }

  const food = foods.find((item) => item.id === id);
  if (!food) return;

  const confirmed = confirm(
    `Permanently delete "${food.name}" from the menu? This cannot be undone.`,
  );
  if (!confirmed) return;

  const { error } = await supabaseClient
    .from("foods")
    .delete()
    .eq("id", id)
    .eq("hotel_id", STAFF_HOTEL_ID);

  if (error) {
    console.error("Food delete error:", error);
    toast("Could not delete item: " + error.message);
    return;
  }

  await fetchFoods();
  renderAnalytics();
  clearFoodForm();
  toast("Food item deleted.");
}

async function chooseSpecial() {
  if (staffRole !== "admin") {
    toast("Only an admin can change today's special.");
    return;
  }

  const names = foods.map((food) => food.name);
  const choice = prompt(
    "Enter the exact food name for today's special:\n" + names.join("\n"),
  );
  if (!choice) return;

  const selected = foods.find(
    (food) => food.name.toLowerCase() === choice.trim().toLowerCase(),
  );
  if (!selected) {
    toast("Food item not found.");
    return;
  }

  const clearResult = await supabaseClient
    .from("foods")
    .update({ is_special: false })
    .eq("hotel_id", STAFF_HOTEL_ID);

  if (clearResult.error) {
    console.error("Clear special error:", clearResult.error);
    toast("Could not update today's special: " + clearResult.error.message);
    return;
  }

  const setResult = await supabaseClient
    .from("foods")
    .update({ is_special: true })
    .eq("id", selected.id)
    .eq("hotel_id", STAFF_HOTEL_ID);

  if (setResult.error) {
    console.error("Set special error:", setResult.error);
    toast("Could not set today's special: " + setResult.error.message);
    return;
  }

  await fetchFoods();
  renderAnalytics();
  toast("Today's special updated.");
}

async function restoreStaffSession() {
  const { data, error } = await supabaseClient.auth.getSession();

  if (error || !data.session) return false;

  const user = data.session.user;

  const { data: staff, error: staffError } = await supabaseClient
    .from("hotel_staff")
    .select("role, hotel_id")
    .eq("user_id", user.id)
    .eq("hotel_id", STAFF_HOTEL_ID)
    .maybeSingle();

  if (staffError || !staff) return false;

  staffUser = user;
  staffRole = staff.role;
  sessionStorage.setItem("qd_staff_role", staffRole);

  updateStaffNavigation();

  return true;
}

/* APPLICATION START */

async function init() {
  if (tableNo < 1 || tableNo > 12) tableNo = 1;

  updateHeader();

  await restoreStaffSession();

  const hasSelectedTable =
    urlParams.has("table") ||
    (savedSessionTable >= 1 && savedSessionTable <= 12);

  if (!hasSelectedTable && !staffRole) {
    showTableSelection();
  } else {
    await fetchFoods();
  }

  if (staffRole === "chef") {
    await fetchChefOrders();
    showPage("chef");
    subscribeChefOrders();
  }
}

init();
