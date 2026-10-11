/** Fixed application code, never a model-supplied script or selector. No field values. */
export function describeLiveControl(node: Element) {
    const e=node as HTMLElement, input=node as HTMLInputElement;
    const style=getComputedStyle(e),rect=e.getBoundingClientRect();
    const visible=e.isConnected && rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.display!=='none' && !e.closest('[hidden],[inert],[aria-hidden="true"]');
    const tag=e.tagName,type=input.type??'',aria=e.getAttribute('role')??'';
    const labelIds=(e.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
    const label=e.getAttribute('aria-label') || labelIds.map(id=>document.getElementById(id)?.textContent??'').join(' ') ||
        Array.from(input.labels??[]).map(x=>x.textContent??'').join(' ') ||
        (['INPUT','TEXTAREA','SELECT'].includes(tag)?'':e.textContent??'');
    const name=label.trim().replace(/\s+/g,' ').slice(0,400);
    const autocomplete=(input.autocomplete??'').toLowerCase();
    const identity=[name,input.name??'',e.id,autocomplete].join(' ');
    const sensitive=/password|passwd|secret|one-time|otp|verification|security.?code|cc-|credit.?card|card.?number|cvv|cvc|pin\b|密码|验证码/i.test(identity);
    let role:'link'|'button'|'textbox'|'combobox'|null=null;
    if(tag==='A' && e.hasAttribute('href') && !e.hasAttribute('download') && !(e.getAttribute('target')??''))role='link';
    else if(tag==='BUTTON'||(tag==='INPUT'&&['button','submit','reset','checkbox','radio'].includes(type))||aria==='button')role='button';
    else if((tag==='INPUT'&&['text','search'].includes(type))||tag==='TEXTAREA')role='textbox';
    else if(tag==='SELECT'&&!(node as HTMLSelectElement).multiple)role='combobox';
    const form=input.form;
    const options=tag==='SELECT'?Array.from((node as HTMLSelectElement).options).map((o,index)=>({index,name:o.text.slice(0,400),value:o.value,disabled:o.disabled||o.parentElement?.hasAttribute('disabled')})):[];
    const selectableNames=options.filter(o=>!o.disabled&&o.name.trim()).map(o=>o.name.trim().replace(/\s+/g,' '));
    const unambiguousOptions=new Set(selectableNames).size===selectableNames.length;
    const descriptor={tag,type,aria,name,id:e.id,field:input.name??'',autocomplete,disabled:input.disabled===true||e.getAttribute('aria-disabled')==='true',readOnly:input.readOnly===true,
        href:tag==='A'?(node as HTMLAnchorElement).href:'',target:e.getAttribute('target')??'',checked:['checkbox','radio'].includes(type)?input.checked:null,
        controlValue:tag==='BUTTON'||tag==='INPUT'&&['button','submit','reset','checkbox','radio'].includes(type)?input.value:null,
        form:form?{id:form.id,name:form.name,action:form.action,method:form.method,target:form.target,enctype:form.enctype,noValidate:form.noValidate}:null,
        formNoValidate:input.formNoValidate===true,formEnctype:e.getAttribute('formenctype')??'',
        formAction:e.hasAttribute('formaction')?(input as HTMLInputElement).formAction:'',formMethod:e.getAttribute('formmethod')??'',formTarget:e.getAttribute('formtarget')??'',options};
    return {visible,eligible:!!role && !sensitive && !!name && !descriptor.disabled && !descriptor.readOnly && options.length<=100 && unambiguousOptions,role,
        name:descriptor.checked===null?name:`${name} (${descriptor.checked?'checked':'unchecked'})`,descriptor,
        options:options.filter(o=>!o.disabled&&o.name.trim())};
}

export function liveVisibleText():string {
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const parts:string[]=[];let count=0;
    while(walker.nextNode() && count<12000){const node=walker.currentNode,parent=node.parentElement;
        if(!parent||parent.closest('script,style,noscript,textarea,input,select,[hidden],[inert],[aria-hidden="true"]'))continue;
        const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||!parent.getClientRects().length)continue;
        const value=(node.textContent??'').trim();if(value){parts.push(value.slice(0,12000-count));count+=value.length;}
    }return parts.join('\n').slice(0,12000);
}
