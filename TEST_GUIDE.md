# ARKAIOS-Remote: Testing Guide

## Overview

This guide provides a comprehensive testing suite for the ARKAIOS-Remote system, which enables remote desktop capture and control through AI agents.

## Prerequisites

- Node.js and npm installed
- `arkaios-service-proxy` running on port 4000
- `curl` command available
- Bash shell

## Quick Start

1. **Start the proxy server**:
   ```bash
   npm start
   # Should output: "Proxy on :4000"
   ```

2. **Run the test suite** (in another terminal):
   ```bash
   bash test-remote.sh
   ```

## Test Suite Script

Save the following script as `test-remote.sh` and execute it:

```bash
#!/bin/bash

# =====================================================
# ARKAIOS-REMOTE: TESTING SUITE v1.0
# Script para validar flujo completo end-to-end
# =====================================================

set -euo pipefail

# Configuration
PROXY_URL="${PROXY_URL:-http://localhost:4000}"
PROXY_API_KEY="${PROXY_API_KEY:-}"
COLOR_RESET='\033[0m'
COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_BLUE='\033[0;34m'
COLOR_YELLOW='\033[1;33m'

# Auth header array (prevents shell expansion issues)
AUTH_HEADER=()
if [ -n "$PROXY_API_KEY" ]; then
  AUTH_HEADER=("Authorization: Bearer $PROXY_API_KEY")
fi

# Valid JPEG base64 (1x1 pixel)
JPEG_BASE64="/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8VAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q=="

# Helper functions
log_test() {
  echo -e "${COLOR_BLUE}[TEST]${COLOR_RESET} $1"
}

log_pass() {
  echo -e "${COLOR_GREEN}[PASS]${COLOR_RESET} $1"
}

log_fail() {
  echo -e "${COLOR_RED}[FAIL]${COLOR_RESET} $1"
}

log_info() {
  echo -e "${COLOR_YELLOW}[INFO]${COLOR_RESET} $1"
}

# Test 1: Proxy Health Check
log_test "Proxy Health Check"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$PROXY_URL/health" 2>/dev/null || echo "000")
if [ "$RESPONSE" = "200" ]; then
  log_pass "Proxy is healthy (HTTP $RESPONSE)"
else
  log_fail "Proxy health check failed (HTTP $RESPONSE). Make sure proxy is running on $PROXY_URL"
  exit 1
fi

# Test 2: Session Initialization
log_test "Session Initialization"
SESSION_RESPONSE=$(curl -s -X POST "$PROXY_URL/v1/remote/session/start" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}") || true

SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  log_pass "Session created: $SESSION_ID"
else
  log_fail "Failed to create session. Response: $SESSION_RESPONSE"
  exit 1
fi

# Test 3: Send Frame
log_test "Frame Submission"
FRAME_RESPONSE=$(curl -s -X POST "$PROXY_URL/v1/remote/frame" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -d "{
    \"session_id\": \"$SESSION_ID\",
    \"frame_data\": \"data:image/jpeg;base64,$JPEG_BASE64\",
    \"timestamp\": $(date +%s)
  }") || true

if echo "$FRAME_RESPONSE" | grep -q '"status":"success"\|"frame_id"'; then
  log_pass "Frame submitted successfully"
else
  log_fail "Frame submission failed. Response: $FRAME_RESPONSE"
fi

# Test 4: Get Last Frame
log_test "Frame Retrieval"
GET_FRAME=$(curl -s "$PROXY_URL/v1/remote/last-frame?session_id=$SESSION_ID" \
  "${AUTH_HEADER[@]}") || true

if echo "$GET_FRAME" | grep -q 'data:image/jpeg\|frame_data'; then
  log_pass "Frame retrieved successfully"
else
  log_fail "Frame retrieval failed. Response: $GET_FRAME"
fi

# Test 5: Session Status
log_test "Session Status Check"
STATUS_RESPONSE=$(curl -s "$PROXY_URL/v1/remote/status?session_id=$SESSION_ID" \
  "${AUTH_HEADER[@]}") || true

if echo "$STATUS_RESPONSE" | grep -q '"session_id"'; then
  log_pass "Session status retrieved"
else
  log_fail "Status check failed. Response: $STATUS_RESPONSE"
fi

# Test 6: Send Action (simulated click)
log_test "Action Execution (Simulated Click)"
ACTION_RESPONSE=$(curl -s -X POST "$PROXY_URL/v1/remote/action" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -d "{
    \"session_id\": \"$SESSION_ID\",
    \"action_type\": \"click\",
    \"x\": 100,
    \"y\": 100,
    \"timestamp\": $(date +%s)
  }") || true

if echo "$ACTION_RESPONSE" | grep -q '"status":"success"'; then
  log_pass "Action executed successfully"
else
  log_fail "Action execution failed. Response: $ACTION_RESPONSE"
fi

# Test 7: Session Termination
log_test "Session Termination"
STOP_RESPONSE=$(curl -s -X POST "$PROXY_URL/v1/remote/session/stop" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -d "{
    \"session_id\": \"$SESSION_ID\"
  }") || true

if echo "$STOP_RESPONSE" | grep -q '"status":"success"'; then
  log_pass "Session terminated successfully"
else
  log_fail "Session termination failed. Response: $STOP_RESPONSE"
fi

echo ""
log_info "All tests completed!"
echo ""
```

## Environment Variables

You can customize test behavior with environment variables:

```bash
# Custom proxy URL
export PROXY_URL=http://localhost:4000

# Optional API key
export PROXY_API_KEY=your_secret_key

# Run tests
bash test-remote.sh
```

## Expected Output

When all tests pass, you should see:

```
[TEST] Proxy Health Check
[PASS] Proxy is healthy (HTTP 200)
[TEST] Session Initialization
[PASS] Session created: <session_uuid>
[TEST] Frame Submission
[PASS] Frame submitted successfully
[TEST] Frame Retrieval
[PASS] Frame retrieved successfully
[TEST] Session Status Check
[PASS] Session status retrieved
[TEST] Action Execution (Simulated Click)
[PASS] Action executed successfully
[TEST] Session Termination
[PASS] Session terminated successfully

[INFO] All tests completed!
```

## Troubleshooting

### "Proxy health check failed"
- Ensure proxy is running: `npm start` in the proxy directory
- Check that port 4000 is not blocked by firewall
- Verify PROXY_URL environment variable if custom

### "Failed to create session"
- Check proxy console for error messages
- Ensure proxy server is responding to requests
- Verify authentication header if using API key

### "Frame submission failed"
- Ensure session is properly initialized
- Check that frame_data is valid base64
- Verify Content-Type header is application/json

### "Frame retrieval failed"
- Session must be active (not stopped)
- Verify session_id parameter is correct
- Check proxy logs for errors

### "Action execution failed"
- Session must be active
- Ensure action_type is valid (click, type, scroll, etc.)
- Verify x,y coordinates are reasonable

## Performance Notes

- Each test should complete in < 500ms
- Frame data is base64 encoded for JSON compatibility
- Sessions persist in memory during proxy runtime
- Multiple concurrent sessions are supported

## Next Steps

After successful testing:

1. **Documentation**: Review comprehensive README in main project
2. **Integration**: Integrate with AI agent (Comet) via MCP tools
3. **Production**: Deploy proxy to production environment
4. **Monitoring**: Add monitoring and logging for production use
