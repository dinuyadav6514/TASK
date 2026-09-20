const assert = require("assert");

// Force in-memory database mode for integration tests
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "test-secret-suite-12345";

const authHandler = require("../api/auth");
const tasksHandler = require("../api/tasks");

function mockReqRes(options = {}) {
  const req = {
    method: options.method || "GET",
    url: options.url || "/",
    headers: options.headers || {},
    body: options.body || null,
  };

  let statusCode = 200;
  let headers = {};
  let responseData = null;
  let ended = false;

  const res = {
    setHeader(key, val) {
      headers[key] = val;
      return res;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      ended = true;
      return res;
    },
    end(data) {
      responseData = data;
      ended = true;
      return res;
    },
    get _status() { return statusCode; },
    get _data() { return responseData; },
    get _headers() { return headers; },
  };

  return { req, res };
}

async function runTests() {
  console.log("=== Running Task Terminal Cloud Auth & Sync Tests ===");

  // Test 1: Register a new user
  console.log("1. Registering new user 'dinesh'...");
  {
    const { req, res } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=register",
      body: { username: "dinesh", password: "Password123!" },
    });
    await authHandler(req, res);
    assert.strictEqual(res._status, 201, "Expected status 201 for register");
    assert(res._data.token, "Expected session token in response");
    assert.strictEqual(res._data.user.username, "dinesh", "Expected username dinesh");
    console.log("   ✓ User 'dinesh' registered successfully. Token issued.");
  }

  // Test 2: Prevent duplicate username registration
  console.log("2. Checking duplicate registration prevention...");
  {
    const { req, res } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=register",
      body: { username: "dinesh", password: "AnotherPassword!" },
    });
    await authHandler(req, res);
    assert.strictEqual(res._status, 409, "Expected 409 for duplicate username");
    console.log("   ✓ Duplicate username correctly rejected with 409 Conflict.");
  }

  // Test 3: Login with invalid credentials
  console.log("3. Testing login with wrong password...");
  {
    const { req, res } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh", password: "WrongPassword" },
    });
    await authHandler(req, res);
    assert.strictEqual(res._status, 401, "Expected 401 for wrong password");
    console.log("   ✓ Invalid credentials rejected with 401 Unauthorized.");
  }

  // Test 4: Login with valid credentials
  console.log("4. Testing valid login...");
  let dineshToken = null;
  {
    const { req, res } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh", password: "Password123!" },
    });
    await authHandler(req, res);
    assert.strictEqual(res._status, 200, "Expected 200 for valid login");
    dineshToken = res._data.token;
    assert(dineshToken, "Expected auth token");
    console.log("   ✓ Successfully logged in as 'dinesh'.");
  }

  // Test 5: Verify session with /api/auth?action=me
  console.log("5. Testing /api/auth?action=me session check...");
  {
    const { req, res } = mockReqRes({
      method: "GET",
      url: "/api/auth?action=me",
      headers: { authorization: `Bearer ${dineshToken}` },
    });
    await authHandler(req, res);
    assert.strictEqual(res._status, 200, "Expected 200 for valid session");
    assert.strictEqual(res._data.user.username, "dinesh");
    console.log("   ✓ Session validated: confirmed active user 'dinesh'.");
  }

  // Test 6: Device 1 saves tasks for dinesh
  console.log("6. Simulating Device 1: saving tasks to cloud database...");
  const sampleTasks = [
    { id: "t1", name: "Deploy to Vercel", category: "devops", status: "done", progress: 100 },
    { id: "t2", name: "Sync to phone", category: "mobile", status: "progress", progress: 60 },
  ];
  {
    const { req, res } = mockReqRes({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: {
        tasks: sampleTasks,
        categories: ["general", "devops", "mobile"],
      },
    });
    await tasksHandler(req, res);
    assert.strictEqual(res._status, 200, "Expected 200 for saving tasks");
    assert.strictEqual(res._data.count, 2, "Expected 2 tasks saved");
    console.log("   ✓ 2 tasks successfully stored in cloud for 'dinesh'.");
  }

  // Test 7: Multi-user isolation — register second user 'alex' and check isolation
  console.log("7. Testing multi-user data isolation with user 'alex'...");
  let alexToken = null;
  {
    const { req, res } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=register",
      body: { username: "alex", password: "AlexSecretPassword!" },
    });
    await authHandler(req, res);
    assert.strictEqual(res._status, 201);
    alexToken = res._data.token;
  }
  {
    const { req, res } = mockReqRes({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${alexToken}` },
    });
    await tasksHandler(req, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._data.tasks.length, 0, "Alex should NOT see Dinesh's tasks");
    console.log("   ✓ User isolation verified: 'alex' sees 0 tasks, completely isolated from 'dinesh'.");
  }

  // Test 8: Device 2 login and sync: log in as 'dinesh' on a fresh device
  console.log("8. Simulating Device 2: fresh login and cloud fetch for 'dinesh'...");
  {
    // Fresh login on Device 2
    const { req: lReq, res: lRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh", password: "Password123!" },
    });
    await authHandler(lReq, lRes);
    const device2Token = lRes._data.token;

    // Fetch tasks on Device 2
    const { req: tReq, res: tRes } = mockReqRes({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${device2Token}` },
    });
    await tasksHandler(tReq, tRes);
    assert.strictEqual(tRes._status, 200);
    assert.strictEqual(tRes._data.tasks.length, 2, "Device 2 should retrieve exactly the 2 tasks saved from Device 1");
    assert.strictEqual(tRes._data.tasks[0].name, "Deploy to Vercel");
    assert.strictEqual(tRes._data.tasks[1].name, "Sync to phone");
    console.log("   ✓ Multi-device sync verified: Device 2 successfully loaded tasks created on Device 1!");
  }

  console.log("\n🎉 ALL 8 INTEGRATION TESTS PASSED WITH 100% SUCCESS!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
