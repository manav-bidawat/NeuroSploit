"""
Advanced reconnaissance module for NeuroSploitv2.

Performs deep JS analysis, sitemap/robots parsing, API enumeration,
and technology fingerprinting using async HTTP requests.
"""

import re
import json
import asyncio
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlparse

try:
    import aiohttp
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False

try:
    from xml.etree import ElementTree as ET
except ImportError:
    ET = None

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=10) if HAS_AIOHTTP else None
MAX_JS_FILES = 10
MAX_JS_SIZE = 500 * 1024  # 500 KB
MAX_SITEMAP_URLS = 200

# --- Regex patterns for JS analysis ---

RE_API_ENDPOINT = re.compile(r'/api/v[0-9]+/[a-z_/]+')
RE_FETCH_URL = re.compile(r'fetch\(\s*["\']([^"\']+)["\']')
RE_AXIOS_URL = re.compile(r'axios\.(?:get|post|put|patch|delete)\(\s*["\']([^"\']+)["\']')
RE_AJAX_URL = re.compile(r'\$\.ajax\(\s*\{[^}]*url\s*:\s*["\']([^"\']+)["\']', re.DOTALL)
RE_XHR_URL = re.compile(r'\.open\(\s*["\'][A-Z]+["\']\s*,\s*["\']([^"\']+)["\']')

RE_API_KEY = re.compile(
    r'(?:sk-[a-zA-Z0-9]{20,}|pk_(?:live|test)_[a-zA-Z0-9]{20,}'
    r'|AKIA[0-9A-Z]{16}'
    r'|ghp_[a-zA-Z0-9]{36}'
    r'|glpat-[a-zA-Z0-9\-]{20,}'
    r'|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})'
)

RE_INTERNAL_URL = re.compile(
    r'https?://(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)[^\s"\']*'
)

RE_REACT_ROUTE = re.compile(r'path\s*[:=]\s*["\'](/[^"\']*)["\']')
RE_ANGULAR_ROUTE = re.compile(r'path\s*:\s*["\']([^"\']+)["\']')
RE_VUE_ROUTE = re.compile(r'path\s*:\s*["\'](/[^"\']*)["\']')


@dataclass
class JSAnalysisResult:
    """Results from JavaScript file analysis."""
    endpoints: List[str] = field(default_factory=list)
    api_keys: List[str] = field(default_factory=list)
    internal_urls: List[str] = field(default_factory=list)
    secrets: List[str] = field(default_factory=list)


@dataclass
class APISchema:
    """Parsed API schema from Swagger/OpenAPI or GraphQL introspection."""
    endpoints: List[Dict] = field(default_factory=list)
    version: str = ""
    source: str = ""


class DeepRecon:
    """Advanced reconnaissance: JS analysis, sitemap, robots, API enum, fingerprinting."""

    def __init__(self, session: Optional["aiohttp.ClientSession"] = None):
        self._external_session = session is not None
        self._session = session

    async def _get_session(self) -> "aiohttp.ClientSession":
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=REQUEST_TIMEOUT)
            self._external_session = False
        return self._session

    async def close(self):
        if not self._external_session and self._session and not self._session.closed:
            await self._session.close()

    async def _fetch(self, url: str, max_size: int = 0) -> Optional[str]:
        """Fetch URL text with optional size limit. Returns None on any error."""
        try:
            session = await self._get_session()
            async with session.get(url, ssl=False, allow_redirects=True) as resp:
                if resp.status != 200:
                    return None
                if max_size:
                    chunk = await resp.content.read(max_size)
                    return chunk.decode("utf-8", errors="replace")
                return await resp.text()
        except Exception:
            return None

    # ------------------------------------------------------------------
    # JS file analysis
    # ------------------------------------------------------------------

    async def crawl_js_files(self, base_url: str, js_urls: List[str]) -> JSAnalysisResult:
        """Fetch and analyse JavaScript files for endpoints, keys, and secrets."""
        result = JSAnalysisResult()
        urls_to_scan = js_urls[:MAX_JS_FILES]

        tasks = [self._fetch(urljoin(base_url, u), max_size=MAX_JS_SIZE) for u in urls_to_scan]
        bodies = await asyncio.gather(*tasks, return_exceptions=True)

        seen_endpoints: set = set()
        for body in bodies:
            if not isinstance(body, str):
                continue

            # API endpoint patterns
            for m in RE_API_ENDPOINT.finditer(body):
                seen_endpoints.add(m.group(0))
            for regex in (RE_FETCH_URL, RE_AXIOS_URL, RE_AJAX_URL, RE_XHR_URL):
                for m in regex.finditer(body):
                    seen_endpoints.add(m.group(1))

            # Route definitions (React Router, Angular, Vue Router)
            for regex in (RE_REACT_ROUTE, RE_ANGULAR_ROUTE, RE_VUE_ROUTE):
                for m in regex.finditer(body):
                    seen_endpoints.add(m.group(1))

            # API keys / tokens
            for m in RE_API_KEY.finditer(body):
                val = m.group(0)
                if val not in result.api_keys:
                    result.api_keys.append(val)
                    result.secrets.append(val)

            # Internal / private URLs
            for m in RE_INTERNAL_URL.finditer(body):
                val = m.group(0)
                if val not in result.internal_urls:
                    result.internal_urls.append(val)

        # Resolve endpoints relative to base_url
        for ep in sorted(seen_endpoints):
            resolved = urljoin(base_url, ep) if not ep.startswith("http") else ep
            if resolved not in result.endpoints:
                result.endpoints.append(resolved)

        return result

    # ------------------------------------------------------------------
    # Sitemap parsing
    # ------------------------------------------------------------------

    async def parse_sitemap(self, target: str) -> List[str]:
        """Fetch and parse sitemap XML files for URLs."""
        target = target.rstrip("/")
        candidates = [
            f"{target}/sitemap.xml",
            f"{target}/sitemap_index.xml",
            f"{target}/sitemap1.xml",
        ]
        urls: set = set()

        for sitemap_url in candidates:
            body = await self._fetch(sitemap_url)
            if not body or ET is None:
                continue
            try:
                root = ET.fromstring(body)
            except ET.ParseError:
                continue
            # Handle both sitemapindex and urlset; strip namespace
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if tag == "loc" and elem.text:
                    urls.add(elem.text.strip())
                    if len(urls) >= MAX_SITEMAP_URLS:
                        return sorted(urls)[:MAX_SITEMAP_URLS]

        return sorted(urls)[:MAX_SITEMAP_URLS]

    # ------------------------------------------------------------------
    # Robots.txt parsing
    # ------------------------------------------------------------------

    async def parse_robots(self, target: str) -> List[str]:
        """Parse robots.txt and return resolved paths (Disallow + Allow)."""
        target = target.rstrip("/")
        body = await self._fetch(f"{target}/robots.txt")
        if not body:
            return []

        paths: set = set()
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("#") or ":" not in line:
                continue
            directive, _, value = line.partition(":")
            directive = directive.strip().lower()
            value = value.strip()
            if directive in ("disallow", "allow") and value:
                resolved = urljoin(target + "/", value)
                paths.add(resolved)

        return sorted(paths)

    # ------------------------------------------------------------------
    # API enumeration (Swagger / OpenAPI / GraphQL)
    # ------------------------------------------------------------------

    _API_DOC_PATHS = [
        "/swagger.json",
        "/openapi.json",
        "/api-docs",
        "/v2/api-docs",
        "/swagger/v1/swagger.json",
        "/.well-known/openapi",
        "/api/swagger.json",
    ]

    async def enumerate_api(self, target: str, technologies: List[str]) -> APISchema:
        """Discover and parse API documentation (OpenAPI/Swagger, GraphQL)."""
        target = target.rstrip("/")
        schema = APISchema()

        # Try OpenAPI / Swagger endpoints
        for path in self._API_DOC_PATHS:
            body = await self._fetch(f"{target}{path}")
            if not body:
                continue
            try:
                doc = json.loads(body)
            except (json.JSONDecodeError, ValueError):
                continue

            # Looks like a valid Swagger/OpenAPI doc
            if "paths" in doc or "openapi" in doc or "swagger" in doc:
                schema.version = doc.get("openapi", doc.get("info", {}).get("version", ""))
                schema.source = path
                for route, methods in doc.get("paths", {}).items():
                    for method, detail in methods.items():
                        if method.lower() in ("get", "post", "put", "patch", "delete", "options", "head"):
                            params = [
                                p.get("name", "")
                                for p in detail.get("parameters", [])
                                if isinstance(p, dict)
                            ]
                            schema.endpoints.append({
                                "url": route,
                                "method": method.upper(),
                                "params": params,
                            })
                return schema

        # GraphQL introspection
        if "graphql" in [t.lower() for t in technologies] or not schema.endpoints:
            introspection = await self._graphql_introspect(target)
            if introspection:
                return introspection

        return schema

    async def _graphql_introspect(self, target: str) -> Optional[APISchema]:
        """Attempt GraphQL introspection query."""
        query = '{"query":"{ __schema { queryType { name } types { name fields { name args { name } } } } }"}'
        try:
            session = await self._get_session()
            headers = {"Content-Type": "application/json"}
            async with session.post(
                f"{target}/graphql", data=query, headers=headers, ssl=False
            ) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
        except Exception:
            return None

        if "data" not in data or "__schema" not in data.get("data", {}):
            return None

        schema = APISchema(version="graphql", source="/graphql")
        for type_info in data["data"]["__schema"].get("types", []):
            type_name = type_info.get("name", "")
            if type_name.startswith("__"):
                continue
            for fld in type_info.get("fields", []) or []:
                params = [a["name"] for a in fld.get("args", []) if isinstance(a, dict)]
                schema.endpoints.append({
                    "url": f"/{type_name}/{fld['name']}",
                    "method": "QUERY",
                    "params": params,
                })
        return schema if schema.endpoints else None

    # ------------------------------------------------------------------
    # Deep technology fingerprinting
    # ------------------------------------------------------------------

    _FINGERPRINT_FILES = [
        "/readme.txt", "/README.md", "/CHANGELOG.md", "/CHANGES.txt",
        "/package.json", "/composer.json",
    ]

    _WP_PROBES = [
        "/wp-links-opml.php",
        "/wp-includes/js/wp-embed.min.js",
    ]

    _DRUPAL_PROBES = [
        "/CHANGELOG.txt",
        "/core/CHANGELOG.txt",
    ]

    RE_VERSION = re.compile(r'["\']?version["\']?\s*[:=]\s*["\']?(\d+\.\d+[\w.\-]*)')
    RE_WP_VER = re.compile(r'ver=(\d+\.\d+[\w.\-]*)')
    RE_DRUPAL_VER = re.compile(r'Drupal\s+(\d+\.\d+[\w.\-]*)')

    async def deep_fingerprint(
        self, target: str, headers: Dict, body: str
    ) -> List[Dict]:
        """Detect software and versions from well-known files and probes."""
        target = target.rstrip("/")
        results: List[Dict] = []
        seen: set = set()

        def _add(software: str, version: str, source: str):
            key = (software.lower(), version)
            if key not in seen:
                seen.add(key)
                results.append({"software": software, "version": version, "source": source})

        # Generic version files
        tasks = {path: self._fetch(f"{target}{path}") for path in self._FINGERPRINT_FILES}
        bodies = dict(zip(tasks.keys(), await asyncio.gather(*tasks.values(), return_exceptions=True)))

        for path, content in bodies.items():
            if not isinstance(content, str):
                continue
            if path.endswith(".json"):
                try:
                    doc = json.loads(content)
                    name = doc.get("name", "unknown")
                    ver = doc.get("version", "")
                    if ver:
                        _add(name, ver, path)
                except (json.JSONDecodeError, ValueError):
                    pass
            else:
                m = self.RE_VERSION.search(content)
                if m:
                    _add("unknown", m.group(1), path)

        # WordPress probes
        for wp_path in self._WP_PROBES:
            content = await self._fetch(f"{target}{wp_path}")
            if not content:
                continue
            m = self.RE_WP_VER.search(content)
            if m:
                _add("WordPress", m.group(1), wp_path)
            elif "WordPress" in content or "wp-" in content:
                _add("WordPress", "unknown", wp_path)

        # Drupal probes
        for dp_path in self._DRUPAL_PROBES:
            content = await self._fetch(f"{target}{dp_path}")
            if not content:
                continue
            m = self.RE_DRUPAL_VER.search(content)
            if m:
                _add("Drupal", m.group(1), dp_path)

        return results
