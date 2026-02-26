import os
import re
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq

# Load environment variables
load_dotenv()

app = FastAPI(title="CodeRefine API")

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

class CodeReviewRequest(BaseModel):
    code: str
    language: str
    focus_areas: list[str] = ["Bugs", "Security", "Performance"]

def parse_review_response(text: str):
    # Regex to extract sections based on the documentation provided
    patterns = {
        "critical": r"### Critical Issues(.*?)(?=###|$)",
        "high": r"### High Priority(.*?)(?=###|$)",
        "medium": r"### Medium Priority(.*?)(?=###|$)",
        "low": r"### Low Priority(.*?)(?=###|$)"
    }
    
    results = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, text, re.DOTALL)
        results[key] = match.group(1).strip() if match else "No issues detected."
    
    return results

@app.post("/api/review")
async def review_code(request: CodeReviewRequest):
    if not request.code.strip():
        raise HTTPException(status_code=400, detail="Code cannot be empty")

    prompt = f"""
    You are an expert code reviewer with 15+ years of experience. Analyze this {request.language} code.
    Focus on: {', '.join(request.focus_areas)}.
    
    Provide your response in this EXACT format:
    ### Critical Issues
    (List critical bugs or security holes here)
    ### High Priority
    (List major performance or logic issues)
    ### Medium Priority
    (List code smells or best practice violations)
    ### Low Priority
    (List minor cleanup or style suggestions)
    ### Summary
    (Brief overall assessment)
    
    Code to analyze:
    ```{request.language}
    {request.code}
    ```
    """

    try:
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=2000
        )
        
        raw_text = completion.choices[0].message.content
        structured_feedback = parse_review_response(raw_text)
        
        return {
            "raw_feedback": raw_text,
            "structured": structured_feedback
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/rewrite")
async def rewrite_code(request: CodeReviewRequest):
    prompt = f"""
    You are an expert software architect. Rewrite the following {request.language} code to be production-ready.
    Improve performance, security, and follow SOLID principles.
    
    Provide only the code and a list of key improvements.
    
    Code:
    ```{request.language}
    {request.code}
    ```
    """

    try:
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2
        )
        return {"rewritten_code": completion.choices[0].message.content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)