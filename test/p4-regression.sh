#!/usr/bin/env bash
# =====================================================================
# MediShield P4 - regression tests (up to and including Batch 3b)
#
# Run from the project root (the folder that contains package.json):
#     bash test/p4-regression.sh
#
# - Starts its OWN server on port 4010 (your `cds watch` on 4004 is not touched).
# - Every group starts a fresh in-memory SQLite database, so groups do not
#   affect each other. Nothing is written to HANA or to P2's HACKFEST0368.
# - Development test users (package.json): manager, owner, viewer (no password).
#   'alice' is one of CAP's built-in mock users; she has no MediShield role.
# - Since Batch 2 every request needs a login, so reads are done as 'viewer'.
#
# Exit code: 0 = all tests passed, 1 = at least one failure, 2 = server problem.
# =====================================================================

PORT="${PORT:-4010}"
BASE="http://localhost:${PORT}/odata/v4/medi-shield"
LOG="/tmp/p4-test-server.log"
PASS=0
FAIL=0
FAILED_IDS=()
SERVER_PID=""

# ---------- server control -------------------------------------------

port_in_use() { curl -s -o /dev/null "http://localhost:${PORT}/"; }

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
  # Wait until the port is really free, so the next group gets a fresh server
  for _ in $(seq 1 40); do port_in_use || return 0; sleep 0.25; done
  echo "ERROR: port $PORT is still in use by another process. Stop it and re-run."
  exit 2
}
trap stop_server EXIT

# start_server [extra cds-serve args...]   (fresh in-memory DB every time)
start_server() {
  stop_server
  # Start cds-serve directly (not via npx) so that stopping it really stops the server
  local serve=./node_modules/.bin/cds-serve
  [ -x "$serve" ] || { echo "ERROR: $serve not found. Run 'npm install' first."; exit 2; }
  "$serve" --port "$PORT" --in-memory "$@" > "$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "ERROR: server exited during start-up. See $LOG"; exit 2
    fi
    if curl -s -o /dev/null "$BASE/\$metadata"; then return 0; fi
    sleep 0.5
  done
  echo "ERROR: server did not start on port $PORT. See $LOG"
  exit 2
}

# ---------- request helpers ------------------------------------------

# call USER METHOD PATH [JSON]   USER = manager|owner|viewer|- (- = not logged in)
call() {
  local user="$1" method="$2" path="$3" data="${4:-}" out
  local args=(-s -w $'\n%{http_code}' -X "$method")
  [ "$user" != "-" ] && args+=(-u "${user}:")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
  out=$(curl "${args[@]}" "$BASE/$path")
  STATUS="${out##*$'\n'}"
  RESP="${out%$'\n'*}"
}

# check ID DESCRIPTION EXPECTED_STATUS [EXPECTED_TEXT ...]
check() {
  local id="$1" desc="$2" exp="$3"; shift 3
  local ok=1 t
  [ "$STATUS" = "$exp" ] || ok=0
  for t in "$@"; do grep -qF -- "$t" <<< "$RESP" || ok=0; done
  if [ $ok -eq 1 ]; then
    PASS=$((PASS + 1)); printf 'PASS  %-5s %s\n' "$id" "$desc"
  else
    FAIL=$((FAIL + 1)); FAILED_IDS+=("$id")
    printf 'FAIL  %-5s %s\n      expected: %s %s\n      got:      %s %s\n' \
      "$id" "$desc" "$exp" "$*" "$STATUS" "${RESP:0:300}"
  fi
}

# t ID DESCRIPTION USER METHOD PATH JSON EXPECTED_STATUS [EXPECTED_TEXT ...]
t() {
  local id="$1" desc="$2" user="$3" method="$4" path="$5" data="$6"; shift 6
  call "$user" "$method" "$path" "$data"
  check "$id" "$desc" "$@"
}

# count_is ID DESCRIPTION ENTITY_SET FILTER EXPECTED_NUMBER
count_is() {
  local id="$1" desc="$2" set="$3" filter="$4" exp="$5"
  call viewer GET "${set}/\$count?\$filter=$(enc "$filter")"
  if [ "$STATUS" = "200" ] && [ "$RESP" = "$exp" ]; then
    PASS=$((PASS + 1)); printf 'PASS  %-5s %s\n' "$id" "$desc"
  else
    FAIL=$((FAIL + 1)); FAILED_IDS+=("$id")
    printf 'FAIL  %-5s %s\n      expected: count %s\n      got:      HTTP %s, %s\n' \
      "$id" "$desc" "$exp" "$STATUS" "${RESP:0:300}"
  fi
}

# URL-encode spaces and quotes for $filter
enc() { local s="${1// /%20}"; echo "${s//\'/%27}"; }

# Fire the same request twice in parallel; sets PAR_CODES (sorted, e.g. "200 409")
parallel_twice() {
  local user="$1" path="$2" data="$3" f1 f2
  f1=$(mktemp); f2=$(mktemp)
  curl -s -o /dev/null -w '%{http_code}' -u "${user}:" -X POST -H 'Content-Type: application/json' -d "$data" "$BASE/$path" > "$f1" &
  local p1=$!
  curl -s -o /dev/null -w '%{http_code}' -u "${user}:" -X POST -H 'Content-Type: application/json' -d "$data" "$BASE/$path" > "$f2" &
  local p2=$!
  wait $p1 $p2
  PAR_CODES=$(printf '%s\n%s\n' "$(cat "$f1")" "$(cat "$f2")" | sort | tr '\n' ' ' | sed 's/ $//')
  rm -f "$f1" "$f2"
}

# opt_id RISK RANK -> prints the option_id with that rank (as viewer)
opt_id() {
  curl -s -u viewer: "$BASE/Options?\$filter=$(enc "risk_id eq '$1' and option_rank eq $2")&\$select=option_id" \
    | grep -o '"option_id":"[^"]*"' | head -1 | cut -d'"' -f4
}

risk_json() { # risk_id supplier tier confidence evidence [event]
  printf '{"risk":{"risk_id":"%s","event":"%s","region":"Zhejiang","affected_supplier":"%s","tier":%s,"confidence":"%s","source":"test","reason":"test","evidence_type":"%s","matched_on":"test"}}' \
    "$1" "${6:-Port closure in Zhejiang (simulated)}" "$2" "$3" "$4" "$5"
}

# =====================================================================
echo "== Group 1: option decisions, logged in (previous regression) =="
start_server
t 1.01 "Manager approves TO1 (180k)"                  manager POST approveOption '{"option_id":"TO1"}' 200 '"status":"approved"'
t 1.02 "Approve TO1 again"                            manager POST approveOption '{"option_id":"TO1"}' 409 'already been approved'
t 1.03 "Owner rejects approved TO1"                   owner   POST rejectOption  '{"option_id":"TO1","reason":"x"}' 409 'already been approved'
t 1.04 "Edit TO1 after approval"                      manager POST editOption    '{"option_id":"TO1","cost_estimate":999999}' 409 'Finalised options'
t 1.05 "Manager approves TO2 (250k)"                  manager POST approveOption '{"option_id":"TO2"}' 200 '"status":"pending_owner"' '"success":false'
t 1.06 "Approve unknown option"                       owner   POST approveOption '{"option_id":"NOPE"}' 404 'not found'
t 1.07 "Approve without option ID"                    manager POST approveOption '{}' 400 'Option ID is required'
t 1.08 "Reject without reason"                        manager POST rejectOption  '{"option_id":"TO2"}' 400
t 1.09 "Edit with negative cost"                      manager POST editOption    '{"option_id":"TO2","cost_estimate":-5}' 400
t 1.10 "Edit with no fields"                          manager POST editOption    '{"option_id":"TO2"}' 400
t 1.11 "Edit without the deprecated approved_by"      manager POST editOption    '{"option_id":"TO2","cost_estimate":260000}' 200 'still requires plant-owner'
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO1' and status eq 'approved'")"
check 1.12 "Audit: TO1 approval recorded as manager / procurement_manager" 200 '"approved_by":"manager"' '"approver_role":"procurement_manager"'

# =====================================================================
echo "== Group 2: threshold bypass fix (escalation is permanent) =="
start_server
t 2.01 "Manager approves TO2 (250k)"                  manager POST approveOption '{"option_id":"TO2"}' 200 '"status":"pending_owner"'
t 2.02 "Manager edits TO2 cost down to 199,999"       manager POST editOption '{"option_id":"TO2","cost_estimate":199999}' 200 'still requires plant-owner'
t 2.03 "TO2 is still pending_owner at 199,999"        viewer GET "Options('TO2')" '' 200 '"approval_status":"pending_owner"' '"cost_estimate":"199999.00"'
t 2.04 "Manager approves TO2 again"                   manager POST approveOption '{"option_id":"TO2"}' 200 '"status":"pending_owner"' '"success":false'
count_is 2.05 "Only one pending_owner audit row for TO2" AuditLog "option_id eq 'TO2' and status eq 'pending_owner'" 1
t 2.06 "Plant owner approves TO2"                     owner POST approveOption '{"option_id":"TO2"}' 200 '"status":"approved"'
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO2' and status eq 'approved'")"
check 2.07 "Audit: approval by owner / plant_owner" 200 '"approved_by":"owner"' '"approver_role":"plant_owner"'
t 2.08 "Manager raises TO1 to 300,000 (was 180k)"     manager POST editOption '{"option_id":"TO1","cost_estimate":300000}' 200 'updated successfully'
t 2.09 "Manager lowers TO1 to 150,000 before approval" manager POST editOption '{"option_id":"TO1","cost_estimate":150000}' 200 'still requires plant-owner'
t 2.10 "TO1 became pending_owner"                     viewer GET "Options('TO1')" '' 200 '"approval_status":"pending_owner"'
t 2.11 "Manager approves TO1"                         manager POST approveOption '{"option_id":"TO1"}' 200 '"status":"pending_owner"' '"success":false'
t 2.12 "Manager rejects escalated TO1 (Decision A)"   manager POST rejectOption '{"option_id":"TO1","reason":"Too costly"}' 200 '"status":"rejected"'
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO1' and action eq 'reject'")"
check 2.13 "Audit: rejection by manager / procurement_manager" 200 '"approved_by":"manager"' '"approver_role":"procurement_manager"'

start_server
t 2.14 "Manager edits TO1 (never above threshold)"    manager POST editOption '{"option_id":"TO1","cost_estimate":170000}' 200 'updated successfully'
t 2.15 "TO1 is pending"                               viewer GET "Options('TO1')" '' 200 '"approval_status":"pending"'
t 2.16 "Manager approves TO1"                         manager POST approveOption '{"option_id":"TO1"}' 200 '"status":"approved"'
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO1' and action eq 'edit'")"
check 2.17 "Audit: edit by manager / procurement_manager" 200 '"approved_by":"manager"' '"approver_role":"procurement_manager"'
t 2.18 "Manager edits TO2 claiming to be 'Asha'"      manager POST editOption '{"option_id":"TO2","cost_estimate":260000,"approved_by":"Asha"}' 200
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO2' and action eq 'edit'")"
check 2.19 "Audit: recorded as manager, not 'Asha'" 200 '"approved_by":"manager"' '"approver_role":"procurement_manager"'
count_is 2.20 "No audit row claims to be 'Asha'" AuditLog "approved_by eq 'Asha'" 0

# =====================================================================
echo "== Group 3: roles, and request-supplied identity is ignored =="
start_server
t 3.01 "Viewer approves TO1"                          viewer POST approveOption '{"option_id":"TO1"}' 403
t 3.02 "Viewer rejects TO1"                           viewer POST rejectOption  '{"option_id":"TO1","reason":"x"}' 403
t 3.03 "Viewer edits TO1"                             viewer POST editOption    '{"option_id":"TO1","cost_estimate":1}' 403
t 3.04 "Manager claims plant_owner in request (TO2)"  manager POST approveOption '{"option_id":"TO2","approver_role":"plant_owner","approved_by":"Ravi"}' 200 '"status":"pending_owner"' '"success":false'
count_is 3.05 "No audit rows written by viewer" AuditLog "approved_by eq 'viewer'" 0
t 3.06 "TO1 untouched after viewer attempts"          viewer GET "Options('TO1')" '' 200 '"approval_status":"pending"' '"cost_estimate":"180000.00"'
t 3.07 "Alice (no MediShield role) approves TO1"      alice  POST approveOption '{"option_id":"TO1","approver_role":"plant_owner","approved_by":"Ravi"}' 403
t 3.08 "Viewer claims plant_owner in request"         viewer POST approveOption '{"option_id":"TO2","approver_role":"plant_owner","approved_by":"Ravi"}' 403
t 3.09 "TO2 still pending_owner after spoof attempts" viewer GET "Options('TO2')" '' 200 '"approval_status":"pending_owner"'
t 3.10 "Owner approves TO2 claiming procurement_manager/'Asha'" owner POST approveOption '{"option_id":"TO2","approver_role":"procurement_manager","approved_by":"Asha"}' 200 '"status":"approved"'
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO2' and status eq 'approved'")"
check 3.11 "Audit: approval recorded as owner / plant_owner" 200 '"approved_by":"owner"' '"approver_role":"plant_owner"'
t 3.12 "Manager rejects TO1 claiming plant_owner/'Ravi'" manager POST rejectOption '{"option_id":"TO1","reason":"x","approver_role":"plant_owner","approved_by":"Ravi"}' 200 '"status":"rejected"'
call viewer GET "AuditLog?\$filter=$(enc "option_id eq 'TO1' and action eq 'reject'")"
check 3.13 "Audit: rejection recorded as manager / procurement_manager" 200 '"approved_by":"manager"' '"approver_role":"procurement_manager"'
count_is 3.14 "No audit row claims 'Ravi' or 'Asha'" AuditLog "approved_by eq 'Ravi' or approved_by eq 'Asha'" 0

# =====================================================================
echo "== Group 4: createRisk validation =="
start_server
t 4.01 "Valid Tier-2 inferred/medium risk on S3"      manager POST createRisk "$(risk_json RA2 S3 2 medium inferred)" 200 '"status":"created"'
call viewer GET "AuditLog?\$filter=$(enc "risk_id eq 'RA2' and action eq 'risk_detected'")"
check 4.02 "Audit: risk_detected by manager" 200 '"approved_by":"manager"'
t 4.03 "Duplicate risk ID"                            manager POST createRisk "$(risk_json RA2 S3 2 medium inferred)" 409 'already exists'
t 4.04 "Missing required field (source)"              manager POST createRisk '{"risk":{"risk_id":"RA3","event":"e","affected_supplier":"S3","tier":2,"confidence":"low","reason":"r","evidence_type":"news"}}' 400
t 4.05 "Supplier S999 does not exist"                 manager POST createRisk "$(risk_json RA4 S999 2 medium news)" 404 'does not exist'
t 4.06 "Tier 1 sent for Tier-2 supplier S3"           manager POST createRisk "$(risk_json RA5 S3 1 high news)" 400 'does not match'
t 4.07 "Confidence 'High' (uppercase)"                manager POST createRisk "$(risk_json RA6 S3 2 High news)" 400 'low, medium or high'
t 4.08 "Confidence 'banana'"                          manager POST createRisk "$(risk_json RA7 S3 2 banana news)" 400 'low, medium or high'
t 4.09 "Inferred evidence with high confidence"       manager POST createRisk "$(risk_json RA8 S3 2 high inferred)" 400 'Inferred evidence'
t 4.10 "Evidence type 'rumour'"                       manager POST createRisk "$(risk_json RA9 S3 2 low rumour)" 400 'Evidence type'
t 4.11 "Tier 4"                                       manager POST createRisk "$(risk_json RB2 S3 4 low news)" 400 'Tier must be'
t 4.12 "Declared/high Tier-2 risk on S3 is allowed"   manager POST createRisk "$(risk_json RB3 S3 2 high declared)" 200 '"status":"created"'
t 4.13 "Tier-3 risk on S5"                            manager POST createRisk "$(risk_json RB4 S5 3 low news)" 200 '"status":"created"'
t 4.14 "Event longer than 300 characters"             manager POST createRisk "$(risk_json RB5 S3 2 low news "$(printf 'x%.0s' $(seq 1 301))")" 400
t 4.15 "Rejected risk RA4 was not stored"             viewer GET "Risks('RA4')" '' 404
count_is 4.16 "No audit rows for rejected risks" AuditLog "risk_id eq 'RA4' or risk_id eq 'RA5' or risk_id eq 'RA8'" 0

# =====================================================================
echo "== Group 5: supplier messages (lifecycle since Batch 3a) =="
start_server
t 5.01 "Draft M1 for RB1 / option TO1 to Tier-1 S2"   manager POST createMessage '{"message_id":"M1","risk_id":"RB1","option_id":"TO1","to_supplier":"S2","body":"Please confirm revised date (simulated)"}' 200 '"status":"drafted"' '"option_id":"TO1"'
t 5.02 "Duplicate message ID M1"                      manager POST createMessage '{"message_id":"M1","risk_id":"RB1","option_id":"TO1","to_supplier":"S2","body":"x"}' 409
t 5.03 "Create Tier-2 risk RA2 on S3 (setup)"         manager POST createRisk "$(risk_json RA2 S3 2 medium inferred)" 200
t 5.04 "Draft directly to Tier-2 S3 (bypass Tier-1)"  manager POST createMessage '{"message_id":"M2","risk_id":"RA2","option_id":"TO1","to_supplier":"S3","body":"x"}' 400 'routed through Tier-1 supplier S1'
t 5.05 "Draft to the wrong Tier-1 (S2 instead of S1)" manager POST createMessage '{"message_id":"M2","risk_id":"RA2","option_id":"TO1","to_supplier":"S2","body":"x"}' 400 'routed through Tier-1 supplier S1'
t 5.06 "Draft linking an option of another risk"      manager POST createMessage '{"message_id":"M2","risk_id":"RA2","option_id":"TO1","to_supplier":"S1","body":"x"}' 400 'belongs to risk RB1'
t 5.07 "Draft for unknown risk"                       manager POST createMessage '{"message_id":"M3","risk_id":"NORISK","option_id":"TO1","to_supplier":"S1","body":"x"}' 404
t 5.08 "Draft without body"                           manager POST createMessage '{"message_id":"M3","risk_id":"RB1","option_id":"TO1","to_supplier":"S2"}' 400
t 5.09 "Draft with language 'fr'"                     manager POST createMessage '{"message_id":"M3","risk_id":"RB1","option_id":"TO1","to_supplier":"S2","body":"x","language":"fr"}' 400
t 5.10 "Message ID longer than 10 characters"         manager POST createMessage '{"message_id":"M123456789012","risk_id":"RB1","option_id":"TO1","to_supplier":"S2","body":"x"}' 400
t 5.11 "Draft without option_id"                      manager POST createMessage '{"message_id":"M3","risk_id":"RB1","to_supplier":"S2","body":"x"}' 400 'option ID'
t 5.12 "Draft linking an unknown option"              manager POST createMessage '{"message_id":"M3","risk_id":"RB1","option_id":"NOPE","to_supplier":"S2","body":"x"}' 404 'option not found'
t 5.13 "Reply to M1 before sending"                   manager POST recordSupplierReply '{"message_id":"M1","reply_text":"ok"}' 409 'after simulated sending'
t 5.14 "Send drafted M1 (not approved)"               manager POST sendSimulatedMessage '{"message_id":"M1"}' 409 'Approve the message before sending'
t 5.15 "Approve M1 while its option TO1 is pending"   manager POST approveMessage '{"message_id":"M1"}' 409 'Approve the linked recovery option TO1'
t 5.16 "Approve option TO1 (setup)"                   manager POST approveOption '{"option_id":"TO1"}' 200 '"status":"approved"'
t 5.17 "Approve message M1"                           manager POST approveMessage '{"message_id":"M1"}' 200 '"status":"approved"' '"option_id":"TO1"'
t 5.18 "Send M1"                                      manager POST sendSimulatedMessage '{"message_id":"M1"}' 200 '"status":"sent_simulated"' 'No real message was sent'
t 5.19 "Send M1 again"                                manager POST sendSimulatedMessage '{"message_id":"M1"}' 409
t 5.20 "Reply with empty text"                        manager POST recordSupplierReply '{"message_id":"M1","reply_text":"   "}' 400
t 5.21 "Record reply to M1"                           manager POST recordSupplierReply '{"message_id":"M1","reply_text":"Partial shipment possible (simulated)"}' 200 '"status":"reply_received"'
t 5.22 "M1: reply_received, option TO1, about S2"     viewer GET "Messages('M1')" '' 200 '"status":"reply_received"' 'Partial shipment possible' '"option_id":"TO1"' '"about_supplier":"S2"'
t 5.23 "Reply to M1 again"                            manager POST recordSupplierReply '{"message_id":"M1","reply_text":"again"}' 409 'already been recorded'
t 5.24 "Send unknown message"                         manager POST sendSimulatedMessage '{"message_id":"NOPE"}' 404
call viewer GET "AuditLog?\$filter=$(enc "action eq 'message_sent'")"
check 5.25 "Audit: message_sent by manager with message_id and option_id" 200 '"approved_by":"manager"' '"message_id":"M1"' '"option_id":"TO1"'
count_is 5.26 "Audit rows for M1: created, approved, sent, reply" AuditLog "message_id eq 'M1'" 4

# =====================================================================
echo "== Group 6: concurrency (two identical requests at the same time) =="
echo "   NOTE: local SQLite runs requests one at a time. These tests prove the"
echo "   'one winner, loser gets 409, no extra audit row' behaviour, but they are"
echo "   NOT equivalent to concurrency validation on SAP HANA."
start_server
parallel_twice owner approveOption '{"option_id":"TO2"}'
STATUS=$([ "$PAR_CODES" = "200 409" ] && echo ok || echo "$PAR_CODES"); RESP=""
check 6.01 "Two parallel owner approvals of TO2 -> one 200, one 409 (got: $PAR_CODES)" ok
count_is 6.02 "Exactly one approval audit row for TO2" AuditLog "option_id eq 'TO2' and status eq 'approved'" 1
call manager POST createMessage '{"message_id":"M1","risk_id":"RB1","option_id":"TO2","to_supplier":"S2","body":"x"}'
parallel_twice manager approveMessage '{"message_id":"M1"}'
STATUS=$([ "$PAR_CODES" = "200 409" ] && echo ok || echo "$PAR_CODES"); RESP=""
check 6.09 "Two parallel approvals of message M1 -> one 200, one 409 (got: $PAR_CODES)" ok
count_is 6.10 "Exactly one message_approved audit row" AuditLog "action eq 'message_approved'" 1
parallel_twice manager sendSimulatedMessage '{"message_id":"M1"}'
STATUS=$([ "$PAR_CODES" = "200 409" ] && echo ok || echo "$PAR_CODES"); RESP=""
check 6.03 "Two parallel sends of M1 -> one 200, one 409 (got: $PAR_CODES)" ok
count_is 6.04 "Exactly one message_sent audit row" AuditLog "action eq 'message_sent'" 1
parallel_twice manager recordSupplierReply '{"message_id":"M1","reply_text":"ok"}'
STATUS=$([ "$PAR_CODES" = "200 409" ] && echo ok || echo "$PAR_CODES"); RESP=""
check 6.05 "Two parallel replies to M1 -> one 200, one 409 (got: $PAR_CODES)" ok
count_is 6.06 "Exactly one supplier_reply audit row" AuditLog "action eq 'supplier_reply'" 1
parallel_twice manager rejectOption '{"option_id":"TO1","reason":"x"}'
STATUS=$([ "$PAR_CODES" = "200 409" ] && echo ok || echo "$PAR_CODES"); RESP=""
check 6.07 "Two parallel rejections of TO1 -> one 200, one 409 (got: $PAR_CODES)" ok
count_is 6.08 "Exactly one reject audit row for TO1" AuditLog "option_id eq 'TO1' and action eq 'reject'" 1

# =====================================================================
echo "== Group 7: production profile (local SQLite, mocked login; dev test users absent) =="
CDS_CONFIG='{"requires":{"db":{"kind":"sqlite","credentials":{"url":":memory:"},"model":["db/schema.cds"]},"auth":{"kind":"mocked"}}}' \
  start_server --profile production
t 7.01 "Unauthenticated approveOption in production"   - POST approveOption '{"option_id":"TO1","approver_role":"plant_owner","approved_by":"x"}' 401
t 7.02 "Unauthenticated createRisk in production"      - POST createRisk "$(risk_json RA2 S3 2 medium inferred)" 401
t 7.03 "Unauthenticated sendSimulatedMessage in prod." - POST sendSimulatedMessage '{"message_id":"M1"}' 401
t 7.04 "Unauthenticated read in production"            - GET Options '' 401
t 7.05 "Logged in without role: approve in production" alice POST approveOption '{"option_id":"TO1"}' 403
t 7.06 "TO1 unchanged"                                 alice GET "Options('TO1')" '' 200 '"approval_status":"pending"'
call alice GET "AuditLog/\$count"
check 7.07 "No audit rows written" 200
[ "$RESP" = "0" ] || { PASS=$((PASS - 1)); FAIL=$((FAIL + 1)); FAILED_IDS+=("7.07"); echo "FAIL  7.07  audit count is $RESP, expected 0"; }

# =====================================================================
echo "== Group 8: access matrix - 10 entities x GET/POST/PATCH/DELETE x 5 users =="
start_server
# Setup through authorised actions so that Messages and AuditLog have rows
call manager POST createMessage '{"message_id":"M1","risk_id":"RB1","option_id":"TO1","to_supplier":"S2","body":"x"}'
check 8.00 "Setup: draft M1 (writes Messages + AuditLog through an action)" 200 '"status":"drafted"'
call viewer GET "AuditLog/\$count"; AUDIT_BEFORE="$RESP"

# entity | key path | body for POST | body for PATCH
ENTITIES=(
  "Suppliers|Suppliers('S1')|{\"supplier_id\":\"S9\",\"name\":\"x\",\"tier\":1}|{\"name\":\"HACKED\"}"
  "Stock|Stock('Paracetamol%20API')|{\"material\":\"X\",\"unit\":\"kg\"}|{\"stock_units\":1}"
  "SupplierDeclarations|SupplierDeclarations('D1')|{\"declaration_id\":\"D9\"}|{\"status\":\"x\"}"
  "Risks|Risks('RB1')|{\"risk_id\":\"R9\",\"event\":\"x\"}|{\"event\":\"x\"}"
  "Impacts|Impacts('RB1')|{\"risk_id\":\"R9\",\"delay_days\":1}|{\"delay_days\":1}"
  "Options|Options('TO1')|{\"option_id\":\"T9\",\"risk_id\":\"RB1\"}|{\"approval_status\":\"approved\"}"
  "Messages|Messages('M1')|{\"message_id\":\"M9\",\"status\":\"sent_simulated\"}|{\"status\":\"sent_simulated\"}"
  "ApprovalRule|ApprovalRule('R1')|{\"rule_id\":\"R9\",\"threshold_cost\":1}|{\"threshold_cost\":999999999}"
  "Simulation|Simulation('SIM1')|{\"sim_id\":\"SIM9\"}|{\"region\":\"x\"}"
  "AuditLog|AuditLog(1)|{\"audit_id\":999,\"risk_id\":\"RB1\",\"action\":\"approve\",\"status\":\"approved\"}|{\"status\":\"forged\"}"
)
n=0
for row in "${ENTITIES[@]}"; do
  IFS='|' read -r ent key postbody patchbody <<< "$row"
  for user in - viewer alice manager owner; do
    label="${user/-/anonymous}"
    exp_read=200; exp_write=405
    [ "$user" = "-" ] && { exp_read=401; exp_write=401; }
    n=$((n + 1)); t "8.$n" "GET    $ent as $label" "$user" GET "$ent" '' "$exp_read"
    n=$((n + 1)); t "8.$n" "POST   $ent as $label" "$user" POST "$ent" "$postbody" "$exp_write"
    n=$((n + 1)); t "8.$n" "PATCH  $key as $label" "$user" PATCH "$key" "$patchbody" "$exp_write"
    n=$((n + 1)); t "8.$n" "DELETE $key as $label" "$user" DELETE "$key" '' "$exp_write"
  done
done

echo "-- data unchanged after all direct write attempts --"
t 8.300 "Supplier S1 unchanged"        viewer GET "Suppliers('S1')" '' 200 '"name":"Sharma Traders"'
t 8.301 "Option TO1 still pending"     viewer GET "Options('TO1')" '' 200 '"approval_status":"pending"'
t 8.302 "Approval threshold unchanged" viewer GET "ApprovalRule('R1')" '' 200 '"threshold_cost":"200000.00"'
t 8.303 "Message M1 still drafted"     viewer GET "Messages('M1')" '' 200 '"status":"drafted"'
t 8.304 "No supplier S9 created"       viewer GET "Suppliers('S9')" '' 404
call viewer GET "AuditLog/\$count"
STATUS=$([ "$RESP" = "$AUDIT_BEFORE" ] && echo 200 || echo "count $RESP vs $AUDIT_BEFORE")
check 8.305 "AuditLog row count unchanged ($AUDIT_BEFORE)" 200
t 8.306 "Audit row 1 not modified"     viewer GET "AuditLog(1)" '' 200 '"action":"message_created"'

echo "== Group 9: all 11 actions x anonymous / viewer / alice =="
ACTIONS=(
  "createRisk|$(risk_json RA2 S3 2 medium inferred)"
  "approveOption|{\"option_id\":\"TO1\",\"approver_role\":\"plant_owner\",\"approved_by\":\"x\"}"
  "rejectOption|{\"option_id\":\"TO1\",\"reason\":\"x\",\"approver_role\":\"plant_owner\",\"approved_by\":\"x\"}"
  "editOption|{\"option_id\":\"TO1\",\"cost_estimate\":1,\"approved_by\":\"x\"}"
  "createMessage|{\"message_id\":\"M2\",\"risk_id\":\"RB1\",\"option_id\":\"TO1\",\"to_supplier\":\"S2\",\"body\":\"x\"}"
  "approveMessage|{\"message_id\":\"M1\"}"
  "rejectMessage|{\"message_id\":\"M1\",\"reason\":\"x\"}"
  "assessRisk|{\"risk_id\":\"RB1\"}"
  "generateMessageDraft|{\"option_id\":\"TO1\"}"
  "sendSimulatedMessage|{\"message_id\":\"M1\"}"
  "recordSupplierReply|{\"message_id\":\"M1\",\"reply_text\":\"x\"}"
)
n=0
for row in "${ACTIONS[@]}"; do
  IFS='|' read -r act body <<< "$row"
  n=$((n + 1)); t "9.$n" "$act as anonymous" - POST "$act" "$body" 401
  n=$((n + 1)); t "9.$n" "$act as viewer"    viewer POST "$act" "$body" 403
  n=$((n + 1)); t "9.$n" "$act as alice"     alice  POST "$act" "$body" 403
done
call viewer GET "AuditLog/\$count"
STATUS=$([ "$RESP" = "$AUDIT_BEFORE" ] && echo 200 || echo "count $RESP vs $AUDIT_BEFORE")
check 9.90 "No audit rows written by refused action calls" 200
t 9.91 "Risk RA2 was not created" viewer GET "Risks('RA2')" '' 404
t 9.92 "Message M1 still drafted" viewer GET "Messages('M1')" '' 200 '"status":"drafted"'
t 9.93 "Message M2 was not created" viewer GET "Messages('M2')" '' 404
t 9.94 "RB1 not assessed by refused calls" viewer GET "Impacts('RB1')" '' 404
stop_server

# =====================================================================
echo "== Group 10: message approval, own-option check, rejection, generated IDs (Batch 3a) =="
start_server
call manager POST createMessage '{"risk_id":"RB1","option_id":"TO2","to_supplier":"S2","body":"Draft for TO2 (simulated)"}'
check 10.01 "Draft without message_id -> ID generated" 200 '"status":"drafted"' '"option_id":"TO2"'
GEN=$(grep -o '"message_id":"[^"]*"' <<< "$RESP" | cut -d'"' -f4)
STATUS=$([[ "$GEN" =~ ^M[0-9A-Z]{9}$ ]] && echo 200 || echo "bad id '$GEN'"); RESP=""
check 10.02 "Generated ID is M + 9 characters ($GEN)" 200
t 10.03 "Generated message readable, about_supplier S2"  viewer GET "Messages('$GEN')" '' 200 '"option_id":"TO2"' '"about_supplier":"S2"' '"status":"drafted"'
t 10.04 "Approve option TO1 (another option of RB1)"     manager POST approveOption '{"option_id":"TO1"}' 200 '"status":"approved"'
t 10.05 "Approve message linked to pending TO2 (issue #6)" manager POST approveMessage "{\"message_id\":\"$GEN\"}" 409 'TO2'
t 10.06 "Manager escalates TO2 (250k) -> pending_owner"  manager POST approveOption '{"option_id":"TO2"}' 200 '"status":"pending_owner"'
t 10.07 "Approve message while TO2 is pending_owner"     manager POST approveMessage "{\"message_id\":\"$GEN\"}" 409 'TO2'
t 10.08 "Reject message without reason"                  manager POST rejectMessage "{\"message_id\":\"$GEN\"}" 400 'reason'
t 10.09 "Reject message"                                 manager POST rejectMessage "{\"message_id\":\"$GEN\",\"reason\":\"Wording unclear\"}" 200 '"status":"rejected"'
t 10.10 "Approve a rejected message"                     owner   POST approveMessage "{\"message_id\":\"$GEN\"}" 409 'rejected'
t 10.11 "Send a rejected message"                        manager POST sendSimulatedMessage "{\"message_id\":\"$GEN\"}" 409 'rejected'
t 10.12 "Reject it again"                                manager POST rejectMessage "{\"message_id\":\"$GEN\",\"reason\":\"x\"}" 409
t 10.13 "Re-use the rejected message ID (decision I)"    manager POST createMessage "{\"message_id\":\"$GEN\",\"risk_id\":\"RB1\",\"option_id\":\"TO2\",\"to_supplier\":\"S2\",\"body\":\"x\"}" 409 'already exists'
call viewer GET "AuditLog?\$filter=$(enc "action eq 'message_rejected'")"
check 10.14 "Audit: message_rejected with reason, actor, IDs" 200 '"approved_by":"manager"' "\"message_id\":\"$GEN\"" '"option_id":"TO2"' 'Wording unclear'
t 10.15 "Draft M5 for approved TO1"                      manager POST createMessage '{"message_id":"M5","risk_id":"RB1","option_id":"TO1","to_supplier":"S2","body":"x"}' 200
t 10.16 "Owner approves M5"                              owner   POST approveMessage '{"message_id":"M5","reason":"OK to send"}' 200 '"status":"approved"'
call viewer GET "AuditLog?\$filter=$(enc "action eq 'message_approved'")"
check 10.17 "Audit: message_approved by owner / plant_owner" 200 '"approved_by":"owner"' '"approver_role":"plant_owner"' '"message_id":"M5"' 'OK to send'
t 10.18 "Reject an approved message"                     manager POST rejectMessage '{"message_id":"M5","reason":"x"}' 409 'Only drafted'
t 10.19 "Approve M5 again"                               manager POST approveMessage '{"message_id":"M5"}' 409
t 10.20 "Approve unknown message"                        manager POST approveMessage '{"message_id":"NOPE"}' 404
t 10.21 "Approve without message ID"                     manager POST approveMessage '{}' 400
t 10.22 "Manager rejects option TO2 (Decision A)"        manager POST rejectOption '{"option_id":"TO2","reason":"Too costly"}' 200 '"status":"rejected"'
t 10.23 "Draft linking rejected option TO2"              manager POST createMessage '{"message_id":"M6","risk_id":"RB1","option_id":"TO2","to_supplier":"S2","body":"x"}' 409 'rejected option'
call viewer GET "Messages?\$filter=$(enc "about_supplier eq 'S2'")&\$select=message_id"
check 10.24 "Filter Messages by about_supplier" 200 '"message_id":"M5"'
count_is 10.25 "Audit rows linked to M5: created, approved" AuditLog "message_id eq 'M5'" 2
stop_server

# =====================================================================
echo "== Group 11: assessRisk / generateMessageDraft / option types (Batch 3b) =="
start_server
t 11.01 "Seed TO1 type is alternate_supplier"            viewer GET "Options('TO1')" '' 200 '"type":"alternate_supplier"'
t 11.02 "Seed TO2 type is expedite_shipment"             viewer GET "Options('TO2')" '' 200 '"type":"expedite_shipment"'
t 11.03 "Draft before the risk is assessed"              manager POST generateMessageDraft '{"option_id":"TO1"}' 409 'Assess risk RB1 first'
t 11.04 "editOption with an unknown type"                manager POST editOption '{"option_id":"TO1","option_type":"air_freight"}' 400 'Option type must be one of'
t 11.05 "editOption with an official type"               manager POST editOption '{"option_id":"TO1","option_type":"buffer_top_up"}' 200
t 11.06 "assessRisk without risk ID"                     manager POST assessRisk '{}' 400
t 11.07 "assessRisk unknown risk"                        manager POST assessRisk '{"risk_id":"NOPE"}' 404
t 11.08 "First assessment of RB1 (replaces seed TO1/TO2) -> assessed" manager POST assessRisk '{"risk_id":"RB1"}' 200 '"status":"assessed"' '"days_of_stock":9' '"delay_days":10' '"has_alternate":true' '"declaration_id":null'
t 11.09 "Seed TO1 replaced"                              viewer GET "Options('TO1')" '' 404
count_is 11.10 "RB1 has exactly 3 options" Options "risk_id eq 'RB1'" 3
call viewer GET "Options?\$filter=$(enc "risk_id eq 'RB1'")&\$select=option_id,type"
N=$(grep -oE '"option_id":"O[0-9A-Z]{9}"' <<< "$RESP" | wc -l); T=$(grep -oE '"type":"(alternate_supplier|expedite_shipment|buffer_top_up)"' <<< "$RESP" | wc -l)
STATUS=$([ "$N" = 3 ] && [ "$T" = 3 ] && echo 200 || echo "ids=$N types=$T"); RESP=""
check 11.11 "All 3 option IDs are O + 9 characters with official types" 200
t 11.12 "Impact stored for RB1"                          viewer GET "Impacts('RB1')" '' 200 '"delay_days":10' '"days_of_stock":9'
call viewer GET "AuditLog?\$filter=$(enc "risk_id eq 'RB1' and action eq 'risk_assessed'")"
check 11.13 "Audit: first assessment recorded as risk_assessed, lists replaced TO1, TO2" 200 '"approved_by":"manager"' 'replaced TO1, TO2'
count_is 11.13b "No risk_reassessed row after the first assessment" AuditLog "risk_id eq 'RB1' and action eq 'risk_reassessed'" 0
OLD=$(opt_id RB1 1)
t 11.14 "Second assessment of RB1 -> reassessed"        manager POST assessRisk '{"risk_id":"RB1"}' 200 '"status":"reassessed"'
count_is 11.14b "Second assessment recorded as risk_reassessed" AuditLog "risk_id eq 'RB1' and action eq 'risk_reassessed'" 1
t 11.15 "Previous option IDs replaced"                   viewer GET "Options('$OLD')" '' 404
count_is 11.16 "Still exactly 3 options for RB1" Options "risk_id eq 'RB1'" 3
count_is 11.17 "Still exactly 1 impact for RB1" Impacts "risk_id eq 'RB1'" 1
count_is 11.18 "Both assessments kept in the audit (never overwritten)" AuditLog "risk_id eq 'RB1' and (action eq 'risk_assessed' or action eq 'risk_reassessed')" 2
BUF=$(opt_id RB1 3)
t 11.19 "Manager approves RB1 rank-3 option (30k)"       manager POST approveOption "{\"option_id\":\"$BUF\"}" 200 '"status":"approved"'
t 11.20 "Reassess after an approval"                     manager POST assessRisk '{"risk_id":"RB1"}' 409 'already decided'
t 11.21 "Approved option untouched after refused reassessment" viewer GET "Options('$BUF')" '' 200 '"approval_status":"approved"'
t 11.22 "Create RA2: Tier-2 S3, 21 days (setup)"         manager POST createRisk "$(risk_json RA2 S3 2 high declared 'Port closure in Zhejiang, 21 days (simulated)')" 200
t 11.23 "Assess RA2: declaration D1, top option 349k"    manager POST assessRisk '{"risk_id":"RA2"}' 200 '"status":"assessed"' '"declaration_id":"D1"' '"material":"Paracetamol API"' '"cost_estimate":349000'
TOP=$(opt_id RA2 1)
t 11.24 "Manager approves 349k option -> pending_owner"  manager POST approveOption "{\"option_id\":\"$TOP\"}" 200 '"status":"pending_owner"'
t 11.25 "Reassess after escalation"                      manager POST assessRisk '{"risk_id":"RA2"}' 409 'pending_owner'
t 11.26 "Create RA3: Tier-2 S3 (setup)"                  manager POST createRisk "$(risk_json RA3 S3 2 medium inferred)" 200
t 11.27 "Assess RA3"                                     manager POST assessRisk '{"risk_id":"RA3"}' 200 '"status":"assessed"'
R1=$(opt_id RA3 1)
call manager POST generateMessageDraft "{\"option_id\":\"$R1\"}"
check 11.28 "Draft for RA3: to Tier-1 S1, about Tier-2 S3, template" 200 '"status":"drafted"' '"to_supplier":"S1"' '"about_supplier":"S3"' '"draft_source":"template"' 'not AI'
DRAFT=$(grep -o '"message_id":"[^"]*"' <<< "$RESP" | cut -d'"' -f4)
t 11.29 "Draft body: labelled, to Tier-1, upstream wording, event and figures" viewer GET "Messages('$DRAFT')" '' 200 '[SIMULATED DRAFT - TEMPLATE, NOT AI] Dear Sharma Traders' 'upstream supply disruption' 'Port closure in Zhejiang (simulated)' 'stock covers 9 days' 'disruption period is 14 days' '"status":"drafted"' "\"option_id\":\"$R1\""
t 11.30 "Reassess after a message exists"                manager POST assessRisk '{"risk_id":"RA3"}' 409 'message already exists'
t 11.31 "Draft with a duplicate message ID"              manager POST generateMessageDraft "{\"option_id\":\"$R1\",\"message_id\":\"$DRAFT\"}" 409 'already exists'
t 11.32 "Draft for unknown option"                       manager POST generateMessageDraft '{"option_id":"NOPE"}' 404
R3=$(opt_id RA3 3)
t 11.33 "Reject RA3 rank-3 option (setup)"               manager POST rejectOption "{\"option_id\":\"$R3\",\"reason\":\"Not needed\"}" 200
t 11.34 "Draft for a rejected option"                    manager POST generateMessageDraft "{\"option_id\":\"$R3\"}" 409 'rejected option'
t 11.35 "Viewer cannot assess"                           viewer POST assessRisk '{"risk_id":"RA3"}' 403
t 11.36 "Viewer cannot generate drafts"                  viewer POST generateMessageDraft "{\"option_id\":\"$R1\"}" 403

echo "-- end-to-end demo scenario A: Tier-2 port closure -> owner approval -> simulated message -> reply --"
t 11.40 "createRisk RA4 (Tier-2 S3, 21 days, declared)"  manager POST createRisk "$(risk_json RA4 S3 2 high declared 'Port closure in Zhejiang, 21 days (simulated)')" 200
t 11.41 "assessRisk RA4"                                 manager POST assessRisk '{"risk_id":"RA4"}' 200 '"declaration_id":"D1"'
A1=$(opt_id RA4 1)
t 11.42 "Manager approves top option -> pending_owner"   manager POST approveOption "{\"option_id\":\"$A1\"}" 200 '"status":"pending_owner"'
t 11.43 "Plant owner approves it"                        owner   POST approveOption "{\"option_id\":\"$A1\"}" 200 '"status":"approved"'
call manager POST generateMessageDraft "{\"option_id\":\"$A1\"}"
check 11.44 "Draft generated for the approved option" 200 '"status":"drafted"' '"to_supplier":"S1"'
AM=$(grep -o '"message_id":"[^"]*"' <<< "$RESP" | cut -d'"' -f4)
t 11.45 "Approve the message"                            manager POST approveMessage "{\"message_id\":\"$AM\"}" 200 '"status":"approved"'
t 11.46 "Send (simulated)"                               manager POST sendSimulatedMessage "{\"message_id\":\"$AM\"}" 200 'No real message was sent'
t 11.47 "Record the Tier-1 reply"                        manager POST recordSupplierReply "{\"message_id\":\"$AM\",\"reply_text\":\"S3 affected; 60 percent share, no backup (simulated)\"}" 200 '"status":"reply_received"'
count_is 11.48 "Audit trail for RA4: 8 rows (risk, assess, escalate, approve, draft, approve msg, send, reply)" AuditLog "risk_id eq 'RA4'" 8

echo "-- parallel assessment of the same new risk --"
call manager POST createRisk "$(risk_json RA5 S3 2 medium inferred)"
parallel_twice manager assessRisk '{"risk_id":"RA5"}'
STATUS=$([ "$PAR_CODES" = "200 200" ] && echo ok || echo "$PAR_CODES"); RESP=""
check 11.50 "Two parallel assessments -> both allowed by rule 5 while pending (got: $PAR_CODES)" ok
count_is 11.51 "RA5: still exactly 3 options" Options "risk_id eq 'RA5'" 3
count_is 11.52 "RA5: exactly 1 impact" Impacts "risk_id eq 'RA5'" 1
count_is 11.53 "RA5: two assessment audit rows" AuditLog "risk_id eq 'RA5' and (action eq 'risk_assessed' or action eq 'risk_reassessed')" 2
count_is 11.54 "RA5: exactly one of them is risk_assessed (first)" AuditLog "risk_id eq 'RA5' and action eq 'risk_assessed'" 1
stop_server

# =====================================================================
echo "== Group 12: assessRisk data conditions (in-process, own test database) =="
P3_RULES_SHA=57b6825644d021f6d2897a4fb8f1317c1e342c51a61167b8a7eb069f3197d126
P3_DRAFT_SHA=f8408d4c5ee587ffbefdecdcd431fe64bc2c0abf8e17163f8a29bfcadb7a8f66
STATUS=$([ "$(sha256sum srv/lib/rules.cjs | cut -d' ' -f1)" = "$P3_RULES_SHA" ] && echo 200 || echo changed); RESP=""
check 12.00a "P3 rules.cjs is byte-identical to P3's delivered file" 200
STATUS=$([ "$(sha256sum srv/lib/draftMessage.cjs | cut -d' ' -f1)" = "$P3_DRAFT_SHA" ] && echo 200 || echo changed); RESP=""
check 12.00b "P3 draftMessage.cjs is byte-identical to P3's delivered file" 200
NODE_OUT=$(node test/p4-assess-cases.mjs 2>&1)
grep -E '^(PASS|FAIL|      )' <<< "$NODE_OUT"
NODE_LINE=$(grep '^NODE_RESULT' <<< "$NODE_OUT")
if [ -z "$NODE_LINE" ]; then
  FAIL=$((FAIL + 1)); FAILED_IDS+=("12.xx"); echo "FAIL  12.xx  node test did not complete:"; tail -20 <<< "$NODE_OUT"
else
  read -r _ NP NF <<< "$NODE_LINE"
  PASS=$((PASS + NP)); FAIL=$((FAIL + NF))
  [ "$NF" -gt 0 ] && FAILED_IDS+=($(grep '^FAIL' <<< "$NODE_OUT" | awk '{print $2}'))
fi

# =====================================================================
echo
echo "RESULT: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  echo "Failed: ${FAILED_IDS[*]}"
  exit 1
fi
exit 0
