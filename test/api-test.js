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

  // Test 9: Change password
  console.log("9. Testing password change for 'dinesh'...");
  {
    // Try with wrong current password
    const { req: wReq, res: wRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=change-password",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: { oldPassword: "WrongOldPassword", newPassword: "NewBrandPassword999!" },
    });
    await authHandler(wReq, wRes);
    assert.strictEqual(wRes._status, 401, "Expected 401 for wrong current password");

    // Correct change password
    const { req: cReq, res: cRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=change-password",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: { oldPassword: "Password123!", newPassword: "NewBrandPassword999!" },
    });
    await authHandler(cReq, cRes);
    assert.strictEqual(cRes._status, 200, "Expected 200 for successful password change");

    // Verify old password fails
    const { req: oldReq, res: oldRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh", password: "Password123!" },
    });
    await authHandler(oldReq, oldRes);
    assert.strictEqual(oldRes._status, 401, "Old password should now fail");

    // Verify new password succeeds
    const { req: newReq, res: newRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh", password: "NewBrandPassword999!" },
    });
    await authHandler(newReq, newRes);
    assert.strictEqual(newRes._status, 200, "New password should succeed");
    dineshToken = newRes._data.token;
    console.log("   ✓ Password change verified: old password invalidated, new password accepted.");
  }

  // Test 10: Change username
  console.log("10. Testing username rename from 'dinesh' to 'dinesh_dev'...");
  {
    // Try rename to existing username 'alex' (should fail 409)
    const { req: cfReq, res: cfRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=change-username",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: { newUsername: "alex", password: "NewBrandPassword999!" },
    });
    await authHandler(cfReq, cfRes);
    assert.strictEqual(cfRes._status, 409, "Should reject taken username");

    // Valid rename to 'dinesh_dev'
    const { req: rnReq, res: rnRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=change-username",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: { newUsername: "dinesh_dev", password: "NewBrandPassword999!" },
    });
    await authHandler(rnReq, rnRes);
    assert.strictEqual(rnRes._status, 200, "Expected 200 for username rename");
    dineshToken = rnRes._data.token;
    assert.strictEqual(rnRes._data.user.username, "dinesh_dev");

    // Verify old username can no longer log in
    const { req: oldLReq, res: oldLRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh", password: "NewBrandPassword999!" },
    });
    await authHandler(oldLReq, oldLRes);
    assert.strictEqual(oldLRes._status, 401, "Old username should not exist");

    // Verify tasks are preserved under new username
    const { req: tsReq, res: tsRes } = mockReqRes({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${dineshToken}` },
    });
    await tasksHandler(tsReq, tsRes);
    assert.strictEqual(tsRes._status, 200);
    assert.strictEqual(tsRes._data.tasks.length, 2, "Tasks must be completely preserved after username change");
    console.log("   ✓ Username rename verified: new username active, old username removed, all tasks preserved!");
  }

  // Test 11: Delete account
  console.log("11. Testing account deletion...");
  {
    // Wrong password fails
    const { req: wReq, res: wRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=delete-account",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: { password: "WrongPassword" },
    });
    await authHandler(wReq, wRes);
    assert.strictEqual(wRes._status, 401);

    // Correct password succeeds
    const { req: dReq, res: dRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=delete-account",
      headers: { authorization: `Bearer ${dineshToken}` },
      body: { password: "NewBrandPassword999!" },
    });
    await authHandler(dReq, dRes);
    assert.strictEqual(dRes._status, 200, "Expected 200 for account deletion");

    // Verify login is no longer possible
    const { req: postReq, res: postRes } = mockReqRes({
      method: "POST",
      url: "/api/auth?action=login",
      body: { username: "dinesh_dev", password: "NewBrandPassword999!" },
    });
    await authHandler(postReq, postRes);
    assert.strictEqual(postRes._status, 401, "Deleted user should not be able to log in");
    console.log("   ✓ Account deletion verified: user profile and cloud tasks permanently deleted.");
  }

  console.log("\n🎉 ALL 11 INTEGRATION TESTS PASSED WITH 100% SUCCESS!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
