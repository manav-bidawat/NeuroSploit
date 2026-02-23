#!/usr/bin/env bash
# ============================================================================
# NeuroSploit v3 - Rebuild & Launch Script
# ============================================================================
# Usage: chmod +x rebuild.sh && ./rebuild.sh
# Options:
#   --backend-only   Only start the backend (skip frontend)
#   --frontend-only  Only start the frontend (skip backend)
#   --build          Build frontend for production instead of dev mode
#   --install        Force reinstall all dependencies
#   --reset-db       Delete and recreate the database (for schema changes)
# ============================================================================

set -e

PROJECT_DIR="/opt/NeuroSploitv2"
VENV_DIR="$PROJECT_DIR/venv"
FRONTEND_DIR="$PROJECT_DIR/frontend"
DATA_DIR="$PROJECT_DIR/data"
LOGS_DIR="$PROJECT_DIR/logs"
PID_DIR="$PROJECT_DIR/.pids"
DB_PATH="$DATA_DIR/neurosploit.db"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Parse args
BACKEND_ONLY=false
FRONTEND_ONLY=false
PRODUCTION_BUILD=false
FORCE_INSTALL=false
RESET_DB=false

for arg in "$@"; do
  case $arg in
    --backend-only)  BACKEND_ONLY=true ;;
    --frontend-only) FRONTEND_ONLY=true ;;
    --build)         PRODUCTION_BUILD=true ;;
    --install)       FORCE_INSTALL=true ;;
    --reset-db)      RESET_DB=true ;;
  esac
done

header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

step() {
  echo -e "${GREEN}[+]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[!]${NC} $1"
}

fail() {
  echo -e "${RED}[x]${NC} $1"
  exit 1
}

# ============================================================================
# 0. Kill previous instances
# ============================================================================
header "Stopping previous instances"

mkdir -p "$PID_DIR"

# Kill by PID files if they exist
for pidfile in "$PID_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    step "Stopping process $pid ($(basename "$pidfile" .pid))"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done

# Also kill any lingering uvicorn/vite on our ports
if lsof -ti:8000 >/dev/null 2>&1; then
  step "Killing process on port 8000"
  kill $(lsof -ti:8000) 2>/dev/null || true
fi
if lsof -ti:3000 >/dev/null 2>&1; then
  step "Killing process on port 3000"
  kill $(lsof -ti:3000) 2>/dev/null || true
fi

sleep 1
step "Previous instances stopped"

# ============================================================================
# 1. Ensure directories exist
# ============================================================================
header "Preparing directories"
mkdir -p "$DATA_DIR" "$LOGS_DIR" "$PID_DIR"
mkdir -p "$PROJECT_DIR/reports/screenshots"
mkdir -p "$PROJECT_DIR/reports/benchmark_results/logs"
mkdir -p "$DATA_DIR/vectorstore"
mkdir -p "$DATA_DIR/checkpoints"
step "Directories ready"

# ============================================================================
# 1b. Database reset (if requested)
# ============================================================================
if [ "$RESET_DB" = true ]; then
  header "Resetting database"
  if [ -f "$DB_PATH" ]; then
    BACKUP="$DB_PATH.backup.$(date +%Y%m%d%H%M%S)"
    step "Backing up existing DB to $BACKUP"
    cp "$DB_PATH" "$BACKUP"
    rm -f "$DB_PATH"
    step "Database deleted (will be recreated with new schema on startup)"
  else
    step "No existing database found"
  fi
fi

# ============================================================================
# 2. Environment check
# ============================================================================
header "Checking environment"

if [ ! -f "$PROJECT_DIR/.env" ]; then
  if [ -f "$PROJECT_DIR/.env.example" ]; then
    warn ".env not found, copying from .env.example"
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  else
    fail ".env file not found and no .env.example to copy from"
  fi
fi
step ".env file present"

# Check Python
if command -v python3 &>/dev/null; then
  PYTHON=python3
elif command -v python &>/dev/null; then
  PYTHON=python
else
  fail "Python not found. Install Python 3.10+"
fi
step "Python: $($PYTHON --version)"

# Check Node
if command -v node &>/dev/null; then
  step "Node: $(node --version)"
else
  if [ "$BACKEND_ONLY" = false ]; then
    fail "Node.js not found. Install Node.js 18+"
  fi
fi

# Check Docker (optional - needed for sandbox & benchmarks)
if command -v docker &>/dev/null; then
  step "Docker: $(docker --version 2>/dev/null | head -1)"
  # Check compose
  if docker compose version &>/dev/null 2>&1; then
    step "Docker Compose: plugin (docker compose)"
  elif command -v docker-compose &>/dev/null; then
    step "Docker Compose: standalone ($(docker-compose version --short 2>/dev/null))"
  else
    warn "Docker Compose not found (needed for sandbox & benchmarks)"
  fi
else
  warn "Docker not found (optional - needed for sandbox & benchmarks)"
fi

# ============================================================================
# 3. Python virtual environment & dependencies
# ============================================================================
if [ "$FRONTEND_ONLY" = false ]; then
  header "Setting up Python backend"

  if [ ! -d "$VENV_DIR" ] || [ "$FORCE_INSTALL" = true ]; then
    step "Creating virtual environment..."
    $PYTHON -m venv "$VENV_DIR"
  fi

  source "$VENV_DIR/bin/activate"
  step "Virtual environment activated"

  if [ "$FORCE_INSTALL" = true ] || [ ! -f "$VENV_DIR/.deps_installed" ]; then
    step "Installing backend dependencies..."
    pip install --quiet --upgrade pip

    # Install from requirements files (pyproject.toml is for tool config only)
    pip install --quiet -r "$PROJECT_DIR/backend/requirements.txt" 2>&1 | tail -5
    pip install --quiet -r "$PROJECT_DIR/requirements.txt" 2>&1 | tail -5
    touch "$VENV_DIR/.deps_installed"
    step "Core dependencies installed"

    # Try optional deps (may fail on Python <3.10)
    if [ -f "$PROJECT_DIR/requirements-optional.txt" ]; then
      step "Installing optional dependencies (best-effort)..."
      pip install --quiet -r "$PROJECT_DIR/requirements-optional.txt" 2>/dev/null && \
        step "Optional deps installed (mcp, playwright)" || \
        warn "Some optional deps skipped (Python 3.10+ required for mcp/playwright)"
    fi
  else
    step "Dependencies already installed (use --install to force)"
  fi

  # Validate key modules
  step "Validating Python modules..."
  $PYTHON -c "
import sys

# === Core Platform (14) ===
core_modules = [
    ('backend.main', 'FastAPI App'),
    ('backend.config', 'Settings'),
    ('core.llm_manager', 'LLM Manager'),
    ('core.model_router', 'Model Router'),
    ('core.scheduler', 'Scheduler'),
    ('core.knowledge_augmentor', 'Knowledge Augmentor'),
    ('core.browser_validator', 'Browser Validator'),
    ('core.mcp_client', 'MCP Client'),
    ('core.mcp_server', 'MCP Server'),
    ('core.sandbox_manager', 'Sandbox Manager'),
    ('core.context_builder', 'Context Builder'),
    ('core.pentest_executor', 'Pentest Executor'),
    ('core.tool_installer', 'Tool Installer'),
    ('core.report_generator', 'Report Generator (CLI)'),
]

# === API Layer (18) ===
api_modules = [
    ('backend.api.v1.agent', 'Agent API'),
    ('backend.api.v1.scans', 'Scans API'),
    ('backend.api.v1.targets', 'Targets API'),
    ('backend.api.v1.prompts', 'Prompts API'),
    ('backend.api.v1.reports', 'Reports API'),
    ('backend.api.v1.dashboard', 'Dashboard API'),
    ('backend.api.v1.vulnerabilities', 'Vulnerabilities API'),
    ('backend.api.v1.settings', 'Settings API'),
    ('backend.api.v1.agent_tasks', 'Agent Tasks API'),
    ('backend.api.v1.scheduler', 'Scheduler API'),
    ('backend.api.v1.vuln_lab', 'VulnLab API'),
    ('backend.api.v1.terminal', 'Terminal API'),
    ('backend.api.v1.sandbox', 'Sandbox API'),
    ('backend.api.v1.knowledge', 'Knowledge API'),
    ('backend.api.v1.mcp', 'MCP API'),
    ('backend.api.v1.providers', 'Providers API'),
    ('backend.api.v1.full_ia', 'Full IA Testing API'),
    ('backend.api.v1.cli_agent', 'CLI Agent API'),
]

# === VulnEngine (18) ===
vuln_modules = [
    ('backend.core.vuln_engine.engine', 'VulnEngine Core'),
    ('backend.core.vuln_engine.registry', 'VulnEngine Registry'),
    ('backend.core.vuln_engine.payload_generator', 'VulnEngine Payloads'),
    ('backend.core.vuln_engine.ai_prompts', 'VulnEngine AI Prompts'),
    ('backend.core.vuln_engine.pentest_playbook', 'VulnEngine Playbook'),
    ('backend.core.vuln_engine.system_prompts', 'Anti-Hallucination Prompts'),
    ('backend.core.vuln_engine.testers.injection', 'Tester: Injection'),
    ('backend.core.vuln_engine.testers.auth', 'Tester: Auth'),
    ('backend.core.vuln_engine.testers.authorization', 'Tester: Authorization'),
    ('backend.core.vuln_engine.testers.client_side', 'Tester: Client-Side'),
    ('backend.core.vuln_engine.testers.file_access', 'Tester: File Access'),
    ('backend.core.vuln_engine.testers.infrastructure', 'Tester: Infrastructure'),
    ('backend.core.vuln_engine.testers.request_forgery', 'Tester: Request Forgery'),
    ('backend.core.vuln_engine.testers.advanced_injection', 'Tester: Advanced Injection'),
    ('backend.core.vuln_engine.testers.logic', 'Tester: Logic'),
    ('backend.core.vuln_engine.testers.data_exposure', 'Tester: Data Exposure'),
    ('backend.core.vuln_engine.testers.cloud_supply', 'Tester: Cloud/Supply Chain'),
    ('backend.core.vuln_engine.testers.base_tester', 'Tester: Base Class'),
]

# === Agent Core (14) ===
agent_modules = [
    ('backend.core.autonomous_agent', 'Autonomous Agent'),
    ('backend.core.agent_memory', 'Agent Memory'),
    ('backend.core.response_verifier', 'Response Verifier'),
    ('backend.core.task_library', 'Task Library'),
    ('backend.core.execution_history', 'Execution History'),
    ('backend.core.methodology_loader', 'Methodology Loader'),
    ('backend.core.ai_pentest_agent', 'AI Pentest Agent'),
    ('backend.core.ai_prompt_processor', 'AI Prompt Processor'),
    ('backend.core.autonomous_scanner', 'Autonomous Scanner'),
    ('backend.core.recon_integration', 'Recon Integration'),
    ('backend.core.report_generator', 'Report Generator (Backend)'),
    ('backend.core.tool_executor', 'Tool Executor'),
    ('backend.core.prompt_engine.parser', 'Prompt Engine Parser'),
    ('backend.core.report_engine.generator', 'Report Engine Generator'),
]

# === Validation Pipeline (6) ===
validation_modules = [
    ('backend.core.negative_control', 'Negative Control Engine'),
    ('backend.core.proof_of_execution', 'Proof of Execution'),
    ('backend.core.confidence_scorer', 'Confidence Scorer'),
    ('backend.core.validation_judge', 'Validation Judge'),
    ('backend.core.access_control_learner', 'Access Control Learner'),
    ('backend.core.adaptive_learner', 'Adaptive Learner'),
]

# === Agent Autonomy (5) ===
autonomy_modules = [
    ('backend.core.request_engine', 'Request Engine'),
    ('backend.core.waf_detector', 'WAF Detector'),
    ('backend.core.strategy_adapter', 'Strategy Adapter'),
    ('backend.core.chain_engine', 'Chain Engine'),
    ('backend.core.auth_manager', 'Auth Manager'),
]

# === AI Reasoning & Intelligence (8) ===
intelligence_modules = [
    ('backend.core.token_budget', 'Token Budget'),
    ('backend.core.reasoning_engine', 'Reasoning Engine'),
    ('backend.core.agent_tasks', 'Agent Tasks'),
    ('backend.core.endpoint_classifier', 'Endpoint Classifier'),
    ('backend.core.cve_hunter', 'CVE Hunter'),
    ('backend.core.deep_recon', 'Deep Recon'),
    ('backend.core.banner_analyzer', 'Banner Analyzer'),
    ('backend.core.param_analyzer', 'Param Analyzer'),
]

# === Testing & Exploitation (8) ===
testing_modules = [
    ('backend.core.payload_mutator', 'Payload Mutator'),
    ('backend.core.xss_context_analyzer', 'XSS Context Analyzer'),
    ('backend.core.xss_validator', 'XSS Validator'),
    ('backend.core.poc_generator', 'PoC Generator'),
    ('backend.core.exploit_generator', 'Exploit Generator'),
    ('backend.core.poc_validator', 'PoC Validator'),
    ('backend.core.request_repeater', 'Request Repeater'),
    ('backend.core.site_analyzer', 'Site Analyzer'),
]

# === Multi-Agent & Orchestration (9) ===
multiagent_modules = [
    ('backend.core.agent_base', 'Specialist Agent Base'),
    ('backend.core.specialist_agents', 'Specialist Agents'),
    ('backend.core.agent_orchestrator', 'Agent Orchestrator'),
    ('backend.core.researcher_agent', 'Researcher AI Agent'),
    ('backend.core.vuln_orchestrator', 'Vuln Orchestrator'),
    ('backend.core.vuln_type_agent', 'Vuln Type Agent'),
    ('backend.core.cli_agent_runner', 'CLI Agent Runner'),
    ('backend.core.cli_output_parser', 'CLI Output Parser'),
    ('backend.core.cli_instructions_builder', 'CLI Instructions Builder'),
]

# === RAG System (5) ===
rag_modules = [
    ('backend.core.rag.engine', 'RAG Engine'),
    ('backend.core.rag.vectorstore', 'RAG VectorStore'),
    ('backend.core.rag.few_shot', 'RAG Few-Shot'),
    ('backend.core.rag.reasoning_templates', 'RAG Reasoning Templates'),
    ('backend.core.rag.reasoning_memory', 'RAG Reasoning Memory'),
]

# === Smart Router (5) ===
router_modules = [
    ('backend.core.smart_router', 'Smart Router Package'),
    ('backend.core.smart_router.provider_registry', 'Provider Registry'),
    ('backend.core.smart_router.router', 'Router Core'),
    ('backend.core.smart_router.token_extractor', 'Token Extractor'),
    ('backend.core.smart_router.token_refresher', 'Token Refresher'),
]

# === Kali Sandbox (3) ===
kali_modules = [
    ('core.tool_registry', 'Tool Registry (56 tools)'),
    ('core.kali_sandbox', 'Kali Sandbox'),
    ('core.container_pool', 'Container Pool'),
]

# === Operations (3) ===
operations_modules = [
    ('backend.core.checkpoint_manager', 'Checkpoint Manager'),
    ('backend.core.notification_manager', 'Notification Manager'),
    ('backend.core.knowledge_processor', 'Knowledge Processor'),
]

all_groups = [
    ('Core Platform', core_modules),
    ('API Layer', api_modules),
    ('VulnEngine', vuln_modules),
    ('Agent Core', agent_modules),
    ('Validation Pipeline', validation_modules),
    ('Agent Autonomy', autonomy_modules),
    ('AI Reasoning & Intelligence', intelligence_modules),
    ('Testing & Exploitation', testing_modules),
    ('Multi-Agent & Orchestration', multiagent_modules),
    ('RAG System', rag_modules),
    ('Smart Router', router_modules),
    ('Kali Sandbox', kali_modules),
    ('Operations', operations_modules),
]

total = 0
errors = 0
for group_name, modules in all_groups:
    print(f'  --- {group_name} ---')
    for mod, name in modules:
        total += 1
        try:
            __import__(mod)
            print(f'  OK   {name}')
        except Exception as e:
            err_short = str(e).split(chr(10))[0][:80]
            print(f'  WARN {name}: {err_short}')
            errors += 1

print(f'\n  {total - errors}/{total} modules loaded ({errors} warnings)')
" 2>&1 || true

  # Validate knowledge base
  step "Validating knowledge base..."
  $PYTHON -c "
import json, os
kb_path = os.path.join('$PROJECT_DIR', 'data', 'vuln_knowledge_base.json')
if os.path.exists(kb_path):
    kb = json.load(open(kb_path))
    types = len(kb.get('vulnerability_types', {}))
    insights = len(kb.get('xbow_insights', kb.get('attack_insights', {})))
    print(f'  OK  Knowledge base: {types} vuln types, {insights} insight categories')
else:
    print('  WARN Knowledge base not found at data/vuln_knowledge_base.json')
" 2>&1 || true

  # Validate VulnEngine coverage
  step "Validating VulnEngine coverage..."
  $PYTHON -c "
from backend.core.vuln_engine.registry import VulnerabilityRegistry
from backend.core.vuln_engine.payload_generator import PayloadGenerator
from backend.core.vuln_engine.ai_prompts import VULN_AI_PROMPTS
from backend.core.vuln_engine.pentest_playbook import PENTEST_PLAYBOOK, get_testing_prompts
from backend.core.vuln_engine.system_prompts import CONTEXT_PROMPTS, VULN_TYPE_PROOF_REQUIREMENTS
r = VulnerabilityRegistry()
p = PayloadGenerator()
total_payloads = sum(len(v) for v in p.payload_libraries.values())
total_prompts = sum(len(get_testing_prompts(v)) for v in PENTEST_PLAYBOOK)
# Count AI prompt builder functions (deep test + stream prompts)
import inspect, backend.core.vuln_engine.ai_prompts as ap
prompt_funcs = [n for n, f in inspect.getmembers(ap, inspect.isfunction) if n.startswith('get_')]
print(f'  OK  Registry: {len(r.VULNERABILITY_INFO)} types, {len(r.TESTER_CLASSES)} testers')
print(f'  OK  Payloads: {total_payloads} across {len(p.payload_libraries)} categories')
print(f'  OK  AI Prompts: {len(VULN_AI_PROMPTS)} per-vuln + {len(prompt_funcs)} builder functions')
print(f'  OK  Playbook: {len(PENTEST_PLAYBOOK)} vuln types, {total_prompts} testing prompts')
print(f'  OK  System Prompts: {len(CONTEXT_PROMPTS)} contexts, {len(VULN_TYPE_PROOF_REQUIREMENTS)} proof reqs')
" 2>&1 || true

  # Validate RAG system
  step "Validating RAG system..."
  $PYTHON -c "
from backend.core.rag.reasoning_templates import REASONING_TEMPLATES
from backend.core.rag.few_shot import FewShotSelector
fs = FewShotSelector()
curated = getattr(fs, '_curated_examples', {})
total_ex = sum(len(ex) for cat in curated.values() if isinstance(cat, dict) for ex in cat.values() if isinstance(ex, list))
print(f'  OK  Reasoning Templates: {len(REASONING_TEMPLATES)} vuln types')
print(f'  OK  Few-Shot Examples: {len(curated)} categories, {total_ex} curated TP/FP examples')
" 2>&1 || true
fi

# ============================================================================
# 4. Frontend dependencies
# ============================================================================
if [ "$BACKEND_ONLY" = false ]; then
  header "Setting up React frontend"

  cd "$FRONTEND_DIR"

  if [ ! -d "node_modules" ] || [ "$FORCE_INSTALL" = true ]; then
    step "Installing frontend dependencies..."
    npm install --silent 2>&1 | tail -3
    step "Frontend dependencies installed"
  else
    step "node_modules present (use --install to force)"
  fi

  cd "$PROJECT_DIR"
fi

# ============================================================================
# 5. Launch backend
# ============================================================================
if [ "$FRONTEND_ONLY" = false ]; then
  header "Starting FastAPI backend (port 8000)"

  source "$VENV_DIR/bin/activate"

  # Export env vars
  set -a
  source "$PROJECT_DIR/.env"
  set +a

  PYTHONPATH="$PROJECT_DIR" uvicorn backend.main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --reload \
    --log-level info \
    > "$LOGS_DIR/backend.log" 2>&1 &

  BACKEND_PID=$!
  echo "$BACKEND_PID" > "$PID_DIR/backend.pid"
  step "Backend started (PID: $BACKEND_PID)"
  step "Backend logs: $LOGS_DIR/backend.log"

  # Wait for backend to be ready
  step "Waiting for backend..."
  for i in $(seq 1 15); do
    if curl -s http://localhost:8000/docs >/dev/null 2>&1; then
      step "Backend is ready"
      break
    fi
    if [ $i -eq 15 ]; then
      warn "Backend may still be starting. Check logs."
    fi
    sleep 1
  done
fi

# ============================================================================
# 6. Launch frontend
# ============================================================================
if [ "$BACKEND_ONLY" = false ]; then
  header "Starting React frontend (port 3000)"

  cd "$FRONTEND_DIR"

  if [ "$PRODUCTION_BUILD" = true ]; then
    step "Building production frontend..."
    npm run build 2>&1 | tail -5
    step "Build complete. Serving from dist/"
    npx vite preview --port 3000 \
      > "$LOGS_DIR/frontend.log" 2>&1 &
  else
    step "Starting development server..."
    npx vite --port 3000 \
      > "$LOGS_DIR/frontend.log" 2>&1 &
  fi

  FRONTEND_PID=$!
  echo "$FRONTEND_PID" > "$PID_DIR/frontend.pid"
  step "Frontend started (PID: $FRONTEND_PID)"
  step "Frontend logs: $LOGS_DIR/frontend.log"

  cd "$PROJECT_DIR"

  # Wait for frontend
  for i in $(seq 1 10); do
    if curl -s http://localhost:3000 >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

# ============================================================================
# 7. Summary
# ============================================================================
header "NeuroSploit v3 is running"

echo ""
if [ "$FRONTEND_ONLY" = false ]; then
  echo -e "  ${GREEN}Backend API:${NC}    http://localhost:8000"
  echo -e "  ${GREEN}API Docs:${NC}       http://localhost:8000/docs"
  echo -e "  ${GREEN}Scheduler API:${NC}  http://localhost:8000/api/v1/scheduler/"
  echo -e "  ${GREEN}VulnLab API:${NC}    http://localhost:8000/api/v1/vuln-lab/"
fi
if [ "$BACKEND_ONLY" = false ]; then
  echo -e "  ${GREEN}Frontend UI:${NC}    http://localhost:3000"
fi
echo ""
echo -e "  ${BLUE}Logs:${NC}"
[ "$FRONTEND_ONLY" = false ] && echo -e "    Backend:  tail -f $LOGS_DIR/backend.log"
[ "$BACKEND_ONLY" = false ]  && echo -e "    Frontend: tail -f $LOGS_DIR/frontend.log"
echo ""
echo -e "  ${YELLOW}Stop:${NC}  $0 (re-run kills previous)"
echo -e "         kill \$(cat $PID_DIR/backend.pid) \$(cat $PID_DIR/frontend.pid)"
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  NeuroSploit v3 - Autonomous AI Penetration Testing Platform${NC}"
echo -e "${GREEN}  116 modules | 100 vuln types | 18 API routes | 18 frontend pages${NC}"
echo -e ""
echo -e "  ${BLUE}VulnEngine (100-Type):${NC}"
echo -e "  - Registry:           100 vuln types, 526+ payloads, 100 testers"
echo -e "  - AI Prompts:         100 per-vuln decision prompts + pentest playbook"
echo -e "  - System Prompts:     12 anti-hallucination composable prompts"
echo -e "  - Methodology:        Deep injection from .md methodology files"
echo -e "  - Knowledge Base:     100 vuln types + RAG-indexed insights"
echo -e ""
echo -e "  ${BLUE}Autonomous Agent (AI-Powered Pentester):${NC}"
echo -e "  - Auto Pentest:       3 AI-parallel streams (recon + junior + tools)"
echo -e "  - AI Master Plan:     Pre-stream strategic planning (target profiling)"
echo -e "  - AI Deep Test:       Iterative OBSERVE->PLAN->EXECUTE->ANALYZE->ADAPT"
echo -e "  - AI Recon Analysis:  Endpoint prioritization, hidden surface probing"
echo -e "  - AI Payload Gen:     Context-aware payloads per endpoint x vuln_type"
echo -e "  - AI Tool Analysis:   Tool output analysis for real findings vs noise"
echo -e "  - Full IA Testing:    Methodology-driven comprehensive sessions"
echo -e "  - Multi-Session:      Up to 5 concurrent scans"
echo -e "  - Pause/Resume/Stop:  Real-time scan control with fast cancel"
echo -e "  - Checkpoint Manager: Crash-resilient scan state save/restore"
echo -e "  - Recon Integration:  40+ tools (subfinder, amass, nuclei, ffuf)"
echo -e "  - WAF Detection:      16 signatures, 12 bypass techniques"
echo -e "  - Strategy Adapter:   Dead endpoints, diminishing returns, recompute"
echo -e "  - Chain Engine:       10 chain rules, exploit chaining, attack graph"
echo -e "  - Auth Manager:       Multi-user, login form detection, session mgmt"
echo -e "  - Request Engine:     Retry, rate limit, circuit breaker, adaptive"
echo -e "  - Request Repeater:   Burp-like send/compare/replay/validate"
echo -e "  - Site Analyzer:      BFS crawl, JS sink detection, AI architecture"
echo -e ""
echo -e "  ${BLUE}Validation Pipeline (Anti-FP):${NC}"
echo -e "  - Negative Controls:  Benign/empty/no-param baseline comparison"
echo -e "  - Proof of Execution: 25+ per-vuln-type proof methods"
echo -e "  - Confidence Scorer:  Numeric 0-100 with breakdown"
echo -e "  - Validation Judge:   Sole authority (controls+proof+AI+score)"
echo -e "  - Access Control:     Adaptive TP/FP learning, 9 patterns"
echo -e "  - Adaptive Learner:   Cross-scan TP/FP learning (100 vuln types)"
echo -e ""
echo -e "  ${BLUE}AI Reasoning & Intelligence:${NC}"
echo -e "  - ReACT Engine:       Think/plan/reflect reasoning loop"
echo -e "  - Token Budget:       Budget tracking with graceful degradation"
echo -e "  - Endpoint Classifier: 8 types with risk scoring"
echo -e "  - CVE Hunter:         NVD API + GitHub exploit search"
echo -e "  - Deep Recon:         JS crawling, sitemap, robots, API enum"
echo -e "  - Banner Analyzer:    80 known CVEs, 19 EOL versions"
echo -e "  - Param Analyzer:     8 semantic categories, risk ranking"
echo -e ""
echo -e "  ${BLUE}Testing & Exploitation:${NC}"
echo -e "  - Payload Mutator:    14 mutation strategies, failure analysis"
echo -e "  - XSS Validator:      Playwright popup/cookie/DOM/event/CSP"
echo -e "  - XSS Context:        8 context checks (attribute, script, etc.)"
echo -e "  - Exploit Generator:  AI-enhanced PoC, zero-day hypothesis"
echo -e "  - PoC Validator:      HTTP replay, per-vuln markers, static analysis"
echo -e "  - PoC Generator:      20+ per-type exploit code generators"
echo -e ""
echo -e "  ${BLUE}Multi-Agent & Orchestration:${NC}"
echo -e "  - 5 Specialists:      Recon, Exploit, Validator, CVEHunter, Report"
echo -e "  - Orchestrator:       3-phase pipeline coordinator with handoffs"
echo -e "  - Researcher AI:      Hypothesis-driven 0-day discovery with Kali"
echo -e "  - Vuln Orchestrator:  Per-vuln-type parallel agent orchestration"
echo -e "  - Vuln Type Agents:   Specialist agents per vulnerability type"
echo -e ""
echo -e "  ${BLUE}CLI Agent (AI CLI inside Kali):${NC}"
echo -e "  - 3 Providers:        Claude Code, Gemini CLI, Codex CLI"
echo -e "  - Standalone Mode:    CLI Agent runs full pentest autonomously"
echo -e "  - Auto Pentest Phase: Optional CLI agent phase in auto pentest"
echo -e "  - 3-Tier Parsing:     JSON markers + regex + AI extraction"
echo -e "  - OAuth Integration:  SmartRouter token injection into container"
echo -e ""
echo -e "  ${BLUE}RAG System:${NC}"
echo -e "  - VectorStore:        BM25/TF-IDF/ChromaDB backends"
echo -e "  - Few-Shot:           Curated TP/FP examples for 15+ vuln types"
echo -e "  - Reasoning Templates: Structured CoT for 18 vuln types"
echo -e "  - Reasoning Memory:   Cross-scan pseudo-fine-tuning"
echo -e ""
echo -e "  ${BLUE}Smart Router (20 Providers):${NC}"
echo -e "  - 8 CLI OAuth:        Claude, Gemini, Copilot, Cursor, etc."
echo -e "  - 11 API Providers:   Anthropic, OpenAI, Google, OpenRouter, etc."
echo -e "  - Tier Failover:      Auto round-robin with quota tracking"
echo -e "  - Token Refresh:      Auto CLI token re-extraction + OAuth refresh"
echo -e ""
echo -e "  ${BLUE}Kali Sandbox (Container-Per-Scan):${NC}"
echo -e "  - Tool Registry:      56 tools (16 pre-installed + 40 on-demand)"
echo -e "  - Container Pool:     Max concurrent, TTL, orphan cleanup"
echo -e "  - VPN Support:        OpenVPN/WireGuard per-container tunnels"
echo -e "  - Researcher AI:      AI-driven tool selection and execution"
echo -e ""
echo -e "  ${BLUE}Platform & Operations:${NC}"
echo -e "  - 18 API Routes:      Agent, Scans, VulnLab, Terminal, Full IA, etc."
echo -e "  - 18 Frontend Pages:  Auto Pentest, VulnLab, Terminal, Dashboard, etc."
echo -e "  - Terminal Agent:     AI chat + Kali sandbox + VPN integration"
echo -e "  - Vuln Lab:           100 types, PortSwigger/CTF/custom targets"
echo -e "  - Knowledge Manager:  Upload/index custom security documents"
echo -e "  - Notifications:      Discord, Telegram, WhatsApp/Twilio alerts"
echo -e "  - Scheduler:          Cron & interval scheduling"
echo -e "  - Benchmark:          104 CTF challenges for accuracy testing"
echo -e "  - AI Reports:         Dual HTML+JSON with per-finding AI analysis"
echo -e "  - MCP Server:         12 tools (screenshot, dns, port scan, etc.)"
echo -e "  - Reset DB:           ./rebuild.sh --reset-db (schema changes)"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Keep script running so bg processes stay alive
wait
