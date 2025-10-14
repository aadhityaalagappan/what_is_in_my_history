from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os, asyncio, re
from typing import List, Dict, Any, Optional
from langchain_openai import OpenAIEmbeddings
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from chromadb import PersistentClient
import httpx

load_dotenv()
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
EMBED_MODEL = "text-embedding-3-large"
EMBED_DIMS = 1024
CHAT_MODEL = "gpt-4o-mini"
CHROMA_DIR = os.getenv("CHROMA_DIR", "./chroma_store")
client = PersistentClient(path=CHROMA_DIR)

class HistoryItem(BaseModel):
    id: str
    lastVisitTime: float
    title: str
    url: str
    domain: str
    dayOfWeek: int
    hour: int
    collectedAt: float
    extracted_content: Optional[Dict[str, Any]] = None

class HistoryBatch(BaseModel):
    items: List[HistoryItem]
    user_id: Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    top_k: int = 20
    user_id: Optional[str] = None

class ChatResponse(BaseModel):
    success: bool
    answer: str
    sources: List[Dict[str, Any]]

def ensure_api_key():
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set")

def embedding_client():
    return OpenAIEmbeddings(model=EMBED_MODEL, dimensions=EMBED_DIMS)

def get_user_id(request_user_id: Optional[str] = None) -> str:
    if request_user_id:
        safe_id = re.sub(r'[^a-zA-Z0-9_-]', '', request_user_id)
        if safe_id:
            return safe_id
    return "local_user"

def col_history(user_id: str):
    collection_name = f"browser_history_{user_id}"
    try: 
        return client.get_collection(collection_name)
    except: 
        return client.create_collection(collection_name, metadata={"hnsw:space":"cosine"})

def col_memory(user_id: str):
    name = f"chat_memory_{user_id}"
    try: 
        return client.get_collection(name)
    except: 
        return client.create_collection(name, metadata={"hnsw:space":"cosine"})

def stable_doc_id(item: HistoryItem) -> str:
    vdate = datetime.fromtimestamp(item.lastVisitTime / 1000).strftime('%Y-%m-%d')
    return f"hist:{item.domain}:{vdate}:{abs(hash(item.url))% (10**9)}"

def get_time_period(hour: int) -> str:
    if 5 <= hour < 12: return "Morning"
    if 12 <= hour < 17: return "Afternoon"
    if 17 <= hour < 22: return "Evening"
    return "Night"

def categorize_url(url: str, title: str) -> str:
    u = url.lower()
    if 'leetcode.com' in u: return "Programming Practice"
    if 'github.com' in u: return "Code Repository"
    if 'chatgpt.com' in u or 'claude.ai' in u or 'perplexity.ai' in u: return "AI Assistant"
    if 'docs.google.com' in u: return "Documentation"
    if 'aws' in u: return "Cloud Services"
    if 'x.com' in u or 'twitter.com' in u: return "Social Media"
    if 'cricbuzz.com' in u: return "Sports News"
    if 'youtube.com' in u or 'music.youtube.com' in u: return "Media"
    if 'spotify.com' in u: return "Music Streaming"
    return "General"

def create_rich_text(it: HistoryItem) -> str:
    visit_dt = datetime.fromtimestamp(it.lastVisitTime/1000)
    
    base_text = f"""Title: {it.title}
URL: {it.url}
Domain: {it.domain}
Visit Date: {visit_dt.strftime('%B %d, %Y')}
Date: {visit_dt.strftime('%Y-%m-%d')}
Day: {visit_dt.strftime('%A')}
Time: {it.hour}:00
Time Period: {get_time_period(it.hour)}
Content Type: {categorize_url(it.url, it.title)}"""

    if it.extracted_content:
        content = it.extracted_content
        
        if content.get('video_title'):
            base_text += f"\nVideo Title: {content['video_title']}"
        if content.get('channel'):
            base_text += f"\nChannel/Artist: {content['channel']}"
        if content.get('parsed_artist'):
            base_text += f"\nArtist: {content['parsed_artist']}"
        if content.get('parsed_song'):
            base_text += f"\nSong: {content['parsed_song']}"
        if content.get('video_type'):
            base_text += f"\nVideo Type: {content['video_type']}"
        if content.get('collaboration'):
            base_text += f"\nCollaboration: Yes"
        
        if content.get('description'):
            desc = content['description'][:800] if len(content['description']) > 800 else content['description']
            base_text += f"\nDescription: {desc}"
        
        if content.get('contextual_keywords'):
            base_text += f"\nContext: {content['contextual_keywords']}"
        
        if content.get('track_name'):
            base_text += f"\nSong/Track: {content['track_name']}"
        if content.get('artist'):
            base_text += f"\nArtist: {content['artist']}"
        if content.get('album'):
            base_text += f"\nAlbum: {content['album']}"
        if content.get('release_year'):
            base_text += f"\nYear: {content['release_year']}"
    
    return base_text.strip()

async def chat_complete(messages: List[Dict[str,str]]) -> str:
    ensure_api_key()
    async with httpx.AsyncClient(timeout=60) as http:
        r = await http.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": CHAT_MODEL, "messages": messages, "temperature": 0.2}
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

def extract_date(query: str) -> Optional[str]:
    q = query.lower()
    current_year = datetime.now().year
    
    if "yesterday" in q: 
        return (datetime.now()-timedelta(days=1)).strftime("%Y-%m-%d")
    if "today" in q:     
        return datetime.now().strftime("%Y-%m-%d")
    
    if "last week" in q:
        return (datetime.now()-timedelta(days=7)).strftime("%Y-%m-%d")
    if "this week" in q:
        return datetime.now().strftime("%Y-%m-%d")
    
    months = {
        'jan':1,'january':1,'feb':2,'february':2,'mar':3,'march':3,'apr':4,'april':4,
        'may':5,'jun':6,'june':6,'jul':7,'july':7,'aug':8,'august':8,'sep':9,'september':9,
        'oct':10,'october':10,'nov':11,'november':11,'dec':12,'december':12
    }
    
    for name, num in months.items():
        m_year = re.search(rf'{name}\s+(\d{{4}})', q)
        if m_year:
            year = int(m_year.group(1))
            return f"{year}-{num:02d}"
        
        m1 = re.search(rf'{name}\s*(\d{{1,2}})', q)
        m2 = re.search(rf'(\d{{1,2}})\s*{name}', q)
        if m1:
            d = int(m1.group(1))
            return f"{current_year}-{num:02d}-{d:02d}"
        if m2:
            d = int(m2.group(1))
            return f"{current_year}-{num:02d}-{d:02d}"
        
        if name in q and len(name) > 3:
            return f"{current_year}-{num:02d}"
    
    m = re.search(r'(\d{4})-(\d{1,2})-(\d{1,2})', q)
    if m: 
        y,mo,d = m.groups()
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    
    m = re.search(r'(\d{1,2})/(\d{1,2})/(\d{4})', q)
    if m: 
        mo,d,y = m.groups()
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    
    return None

def extract_domain(query: str) -> Optional[str]:
    q = query.lower()
    mapping = {
        'youtube':'youtube.com','spotify':'spotify.com','github':'github.com','leetcode':'leetcode.com',
        'google docs':'docs.google.com','gmail':'mail.google.com','x.com':'x.com','twitter':'x.com'
    }
    for k,v in mapping.items():
        if k in q: return v
    return None

def mk_sources(docs: List[str], metas: List[Dict[str,Any]]) -> List[Dict[str,Any]]:
    out=[]
    for i in range(len(docs)):
        m = metas[i] or {}
        out.append({
            "url": m.get("url",""),
            "title": m.get("title", m.get("domain","Source")),
            "meta": f"{m.get('visit_date','')} {m.get('day_name','')} {m.get('time_period','')}".strip()
        })
    return out

def build_context(docs: List[str], metas: List[Dict[str,Any]]) -> str:
    blocks = []
    for i in range(len(docs)):
        m = metas[i] or {}
        doc_text = docs[i] or ''
        
        blocks.append(
            f"SOURCE #{i+1}\n"
            f"{'='*50}\n"
            f"TITLE: {m.get('title', m.get('domain',''))}\n"
            f"URL: {m.get('url','')}\n"
            f"VISIT DATE: {m.get('visit_date','')} ({m.get('day_name','')})\n"
            f"TIME: {m.get('time_period','')}\n"
            f"CATEGORY: {m.get('content_category','')}\n"
            f"\nCONTENT:\n{doc_text}\n"
            f"{'='*50}"
        )
    return "\n\n".join(blocks)

async def distill_and_store_memory(user_id: str, question: str, answer: str):
    prompt = [
        {"role":"system","content":"Condense user preference or a durable fact from the exchange in <= 2 short sentences. If nothing durable, reply with 'NONE'."},
        {"role":"user","content": f"Q: {question}\nA: {answer}"}
    ]
    try:
        summary = await chat_complete(prompt)
    except Exception:
        return
    if not summary or summary.strip().upper().startswith("NONE"):
        return
    emb = embedding_client()
    vec = await asyncio.to_thread(emb.embed_documents, [summary])
    mem_col = col_memory(user_id)
    mem_id = f"mem:{int(datetime.utcnow().timestamp())}"
    mem_col.add(ids=[mem_id], documents=[summary], embeddings=vec, metadatas=[{"user_id":user_id, "ts":datetime.utcnow().isoformat()}])

def extract_artist_from_query(query: str, available_titles: List[str]) -> Optional[str]:
    """Dynamically extract artist name from query"""
    q_lower = query.lower()
    
    stop_words = ['songs', 'song', 'music', 'by', 'from', 'what', 'which', 'show', 'me', 
                  'did', 'i', 'listen', 'to', 'today', 'yesterday', 'last', 'week', 
                  'the', 'a', 'an', 'my', 'all', 'any', 'that', 'in', 'on']
    
    words = q_lower.split()
    query_tokens = [w for w in words if w not in stop_words and len(w) > 2]
    
    if not query_tokens:
        return None
    
    all_artists = set()
    for title in available_titles:
        title_lower = title.lower()
        
        if ' - ' in title:
            main_artist = title.split(' - ', 1)[0].strip()
            main_artist = re.sub(r'^\(\d+\)\s*', '', main_artist)
            all_artists.add(main_artist)
        
        feat_patterns = [
            r'\(feat\.?\s+([^)]+)\)',
            r'\(ft\.?\s+([^)]+)\)',
            r'feat\.?\s+([^,\)]+)',
            r'ft\.?\s+([^,\)]+)',
            r'featuring\s+([^,\)]+)',
            r'with\s+([^,\)]+)'
        ]
        
        for pattern in feat_patterns:
            matches = re.finditer(pattern, title_lower)
            for match in matches:
                feat_artist = match.group(1).strip()
                feat_artist = re.sub(r'^\(\d+\)\s*', '', feat_artist)
                all_artists.add(feat_artist)
    
    best_match = None
    best_score = 0
    
    for artist in all_artists:
        artist_lower = artist.lower()
        artist_tokens = artist_lower.split()
        
        if artist_lower in q_lower:
            return artist
        
        score = 0
        for query_token in query_tokens:
            for artist_token in artist_tokens:
                if query_token == artist_token:
                    score += 2
                elif query_token in artist_token or artist_token in query_token:
                    score += 1
        
        if score > best_score:
            best_score = score
            best_match = artist
    
    if best_score >= 1:
        return best_match
    
    return None

@app.post("/api/history/to_embeddings")
async def rebuild_embeddings(batch: HistoryBatch):
    try:
        if not batch.items:
            raise HTTPException(status_code=400, detail="No items")
        
        user_id = get_user_id(batch.user_id)
        emb = embedding_client()
        docs = []
        
        for it in batch.items:
            text = create_rich_text(it)
            visit_dt = datetime.fromtimestamp(it.lastVisitTime/1000)
            
            meta = {
                "title": it.title, "id": it.id, "url": it.url, "domain": it.domain,
                "dayOfWeek": it.dayOfWeek, "hour": it.hour,
                "visit_date": visit_dt.strftime('%Y-%m-%d'),
                "day_name": visit_dt.strftime('%A'),
                "time_period": get_time_period(it.hour),
                "content_category": categorize_url(it.url, it.title),
            }
            
            if it.extracted_content:
                meta["extracted_content"] = it.extracted_content
            
            docs.append(Document(page_content=text, metadata=meta))
        
        splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = splitter.split_documents(docs)
        texts = [d.page_content for d in chunks]
        vecs = await asyncio.to_thread(embedding_client().embed_documents, texts)

        collection_name = f"browser_history_{user_id}"
        try: 
            client.delete_collection(collection_name)
        except: 
            pass
        
        col = col_history(user_id)
        col.add(
            ids=[f"doc_{i}" for i in range(len(chunks))],
            documents=texts,
            embeddings=vecs,
            metadatas=[d.metadata for d in chunks]
        )
        
        return {
            "success": True,
            "total_items": len(batch.items),
            "chunks_created": len(vecs),
            "message": "ok"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build embeddings: {e}")

@app.post("/api/history/upsert_items")
async def upsert_items(batch: HistoryBatch):
    try:
        if not batch.items:
            return {"ok": True, "upserted": 0}
        
        user_id = get_user_id(batch.user_id)
        emb = embedding_client()
        col = col_history(user_id)
        ids, texts, metas = [], [], []
        
        for it in batch.items:
            visit_dt = datetime.fromtimestamp(it.lastVisitTime/1000)
            ids.append(stable_doc_id(it))
            texts.append(create_rich_text(it))
            
            meta = {
                "title": it.title, "id": it.id, "url": it.url, "domain": it.domain,
                "dayOfWeek": it.dayOfWeek, "hour": it.hour,
                "visit_date": visit_dt.strftime('%Y-%m-%d'),
                "day_name": visit_dt.strftime('%A'),
                "time_period": get_time_period(it.hour),
                "content_category": categorize_url(it.url, it.title),
            }
            
            if it.extracted_content:
                meta["extracted_content"] = it.extracted_content
            
            metas.append(meta)
        
        try:
            existing = col.get(ids=ids)
            existing_ids = set((existing.get("ids") or [])[0] or [])
            if existing_ids:
                col.delete(ids=list(existing_ids))
        except Exception:
            pass
        
        vecs = await asyncio.to_thread(emb.embed_documents, texts)
        col.add(ids=ids, documents=texts, embeddings=vecs, metadatas=metas)
        return {"ok": True, "upserted": len(ids)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upsert failed: {e}")

@app.post("/api/chat/structured", response_model=ChatResponse)
async def chat_structured(req: ChatRequest):
    """Structured chat with Python-based filtering (no complex ChromaDB where clauses)"""
    try:
        ensure_api_key()
        user_id = get_user_id(req.user_id)
        emb = embedding_client()
        hist = col_history(user_id)

        date_filter = extract_date(req.message)
        domain_filter = extract_domain(req.message)

        enhanced = req.message
        if date_filter:
            try:
                if len(date_filter) == 7:
                    dt = datetime.strptime(date_filter + "-01", "%Y-%m-%d")
                    enhanced += f" {dt.strftime('%B %Y')}"
                else:
                    dt = datetime.strptime(date_filter, "%Y-%m-%d")
                    enhanced += f" {dt.strftime('%A %B %d %Y')}"
            except: 
                pass
        
        q_lower = req.message.lower()
        
        exclude_music = any(phrase in q_lower for phrase in [
            'apart from song', 'except song', 'besides song', 
            'other than song', 'excluding song', 'not song', 'no song'
        ])
        
        exclude_youtube = 'apart from youtube' in q_lower or 'except youtube' in q_lower
        
        is_music_query = (
            not exclude_music and 
            any(word in q_lower for word in ['song', 'music', 'sing', 'artist', 'track'])
        )
        
        if is_music_query:
            enhanced += " music audio video song"
            
            if 'piano' in q_lower:
                enhanced += " piano acoustic instrumental"
            if 'guitar' in q_lower:
                enhanced += " guitar acoustic"
            if 'rain' in q_lower:
                enhanced += " rain"
            if 'danc' in q_lower:
                enhanced += " dancing dance"
            if any(word in q_lower for word in ['girl', 'woman', 'female', 'she']):
                enhanced += " female woman girl"
            if any(word in q_lower for word in ['boy', 'man', 'male', 'he']):
                enhanced += " male man boy"
            if 'duet' in q_lower or 'together' in q_lower:
                enhanced += " duet collaboration featuring"
        elif exclude_music:
            enhanced += " browsing web article page website"
        
        qvec = await asyncio.to_thread(emb.embed_query, enhanced)

        res_h = hist.query(
            query_embeddings=[qvec], 
            n_results=min(req.top_k * 5, 200)
        )
        docs_h = (res_h.get("documents") or [[]])[0]
        metas_h = (res_h.get("metadatas") or [[]])[0]

        if not docs_h:
            return ChatResponse(success=True, answer="No matching history found.", sources=[])

        # PYTHON POST-FILTERING by date and domain
        if date_filter or domain_filter:
            filtered_docs = []
            filtered_metas = []
            
            for i, meta in enumerate(metas_h):
                match = True
                
                # Date filter
                if date_filter:
                    visit_date = meta.get('visit_date', '')
                    if len(date_filter) == 7:  # Month YYYY-MM
                        if not visit_date.startswith(date_filter):
                            match = False
                    else:  # Exact date YYYY-MM-DD
                        if visit_date != date_filter:
                            match = False
                
                # Domain filter
                if domain_filter:
                    if meta.get('domain', '') != domain_filter:
                        match = False
                
                if match:
                    filtered_docs.append(docs_h[i])
                    filtered_metas.append(meta)
            
            docs_h = filtered_docs
            metas_h = filtered_metas

        # Extract artist filter
        available_titles = [meta.get('title', '') for meta in metas_h]
        artist_filter = None
        if is_music_query:
            artist_filter = extract_artist_from_query(req.message, available_titles)
        
        # FILTER by exclusions and artist
        final_docs = []
        final_metas = []
        
        for i, meta in enumerate(metas_h):
            title = meta.get('title', '')
            title_lower = title.lower()
            domain = meta.get('domain', '').lower()
            category = meta.get('content_category', '').lower()
            
            should_exclude = False
            
            # Artist filtering
            if artist_filter and is_music_query:
                if artist_filter.lower() not in title_lower:
                    should_exclude = True
            
            # Music exclusion
            if exclude_music:
                if any(indicator in title_lower for indicator in [
                    'official audio', 'official video', 'music video', 'lyric', 
                    'lyrics', '(audio)', '(official)', 'ft.', 'feat.'
                ]):
                    should_exclude = True
                elif domain in ['youtube.com', 'music.youtube.com']:
                    if any(term in title_lower for term in [' - ', 'official', 'audio', 'music', 'ft', 'feat']):
                        should_exclude = True
                elif category in ['media', 'music streaming']:
                    should_exclude = True
            
            # YouTube exclusion
            if exclude_youtube:
                if 'youtube.com' in domain:
                    should_exclude = True
            
            if not should_exclude:
                final_docs.append(docs_h[i] if i < len(docs_h) else '')
                final_metas.append(meta)
        
        docs_h = final_docs[:req.top_k]
        metas_h = final_metas[:req.top_k]
        
        if not docs_h:
            if artist_filter:
                return ChatResponse(success=True, answer=f"No songs featuring {artist_filter} found.", sources=[])
            if date_filter and domain_filter:
                return ChatResponse(success=True, answer=f"No {domain_filter} activity found from {date_filter}.", sources=[])
            return ChatResponse(success=True, answer="No matching results found.", sources=[])

        # BUILD ANSWER
        answer_lines = []
        
        if is_music_query:
            seen_titles = set()
            unique_songs = []
            
            for i, meta in enumerate(metas_h):
                title = meta.get('title', '')
                title_display = re.sub(r'^\(\d+\)\s*', '', title)
                
                title_clean = title_display.lower().strip()
                if title_clean in seen_titles or not title_display:
                    continue
                
                seen_titles.add(title_clean)
                
                artist = "Unknown"
                song = title_display
                
                if ' - ' in title_display:
                    parts = title_display.split(' - ', 1)
                    artist = parts[0].strip()
                    song = parts[1].strip()
                    song = re.sub(r'\s*[\(\[].*?[\)\]]', '', song).strip()
                
                artist_count = 1
                if ', ' in artist or ' & ' in artist or ' feat' in artist.lower() or ' ft.' in artist.lower():
                    artist_count = len(re.split(r',|&| feat\.?| ft\.?', artist))
                
                extracted = meta.get('extracted_content', {})
                context_info = []
                if extracted:
                    if extracted.get('contextual_keywords'):
                        context_info.append(extracted['contextual_keywords'])
                    if extracted.get('video_type'):
                        context_info.append(extracted['video_type'])
                
                unique_songs.append({
                    'artist': artist,
                    'song': song,
                    'title': title_display,
                    'citation': i + 1,
                    'artist_count': artist_count,
                    'context': ', '.join(context_info) if context_info else ''
                })
            
            # Build answer
            if artist_filter:
                answer_lines.append(f"Songs featuring {artist_filter}:\n")
                for song in unique_songs[:20]:
                    context_str = f" ({song['context']})" if song['context'] else ""
                    answer_lines.append(f"• {song['artist']} - {song['song']}{context_str} [#{song['citation']}]")
            elif any(word in q_lower for word in ['3 people', 'three people', 'three artist', '3 artist']):
                filtered = [s for s in unique_songs if s['artist_count'] >= 3]
                if filtered:
                    answer_lines.append(f"Songs with 3 or more artists:\n")
                    for song in filtered[:5]:
                        context_str = f" ({song['context']})" if song['context'] else ""
                        answer_lines.append(f"• {song['artist']} - {song['song']}{context_str} [#{song['citation']}]")
                else:
                    answer_lines.append("No songs with 3 artists found.\n")
                    for song in unique_songs[:10]:
                        answer_lines.append(f"• {song['artist']} - {song['song']} [#{song['citation']}]")
            elif any(word in q_lower for word in ['piano', 'guitar', 'rain', 'danc', 'beach', 'night']):
                filtered = [s for s in unique_songs if s['context'] and any(
                    keyword in q_lower for keyword in s['context'].lower().split(', ')
                )]
                
                if filtered:
                    answer_lines.append(f"Songs matching your description:\n")
                    for song in filtered[:10]:
                        context_str = f" ({song['context']})" if song['context'] else ""
                        answer_lines.append(f"• {song['artist']} - {song['song']}{context_str} [#{song['citation']}]")
                else:
                    answer_lines.append(f"Based on your description:\n")
                    for song in unique_songs[:10]:
                        context_str = f" ({song['context']})" if song['context'] else ""
                        answer_lines.append(f"• {song['artist']} - {song['song']}{context_str} [#{song['citation']}]")
            else:
                answer_lines.append(f"Here are the songs from your history:\n")
                for song in unique_songs[:15]:
                    context_str = f" ({song['context']})" if song['context'] else ""
                    answer_lines.append(f"• {song['artist']} - {song['song']}{context_str} [#{song['citation']}]")
        else:
            if exclude_music:
                answer_lines.append(f"Here's your non-music browsing activity:\n")
            else:
                answer_lines.append(f"Here's what I found:\n")
            
            by_category = {}
            for i, meta in enumerate(metas_h):
                category = meta.get('content_category', 'General')
                if category not in by_category:
                    by_category[category] = []
                
                title = meta.get('title', 'Untitled')
                domain = meta.get('domain', '')
                
                by_category[category].append({
                    'title': title,
                    'domain': domain,
                    'citation': i + 1
                })
            
            for category, items in sorted(by_category.items()):
                if len(by_category) > 1:
                    answer_lines.append(f"\n**{category}:**")
                
                for item in items[:5]:
                    answer_lines.append(f"• {item['title']} ({item['domain']}) [#{item['citation']}]")
        
        answer = "\n".join(answer_lines)
        sources = mk_sources(docs_h, metas_h)

        return ChatResponse(success=True, answer=answer, sources=sources)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {e}")

@app.get("/health")
async def health():
    return {"status":"ok","ts": datetime.utcnow().isoformat()}