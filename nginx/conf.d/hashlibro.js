/**
 * hashlibro.js
 * 
 * NGINX JavaScript module to serve files from a hashstore system.
 * 
 * Functions:
 * - getInfo: Retrieve information about a PID, including paths and authorization status.
 * - getMetadata: Retrieve the system metadata XML for a given PID.
 * - getObject: Serve the actual object file associated with a given PID.
 * 
 * The storage structure is based on SHA-256 hashes of PIDs and their system metadata.
 */

import fs from 'fs';
import xml from 'xml';

const hashstore_root = '/usr/share/nginx/html/hashstore';
const sysmeta_formatid = 'https://ns.dataone.org/service/types/v2.0#SystemMetadata'

async function sha256(data) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

function splitHash(hash) {
    const _width = 2;
    const _depth = 3
    let parts = [];
    for (let d = 0; d < _depth; d++) {
        parts.push(hash.slice(d*_width, (d+1)*_width));
    }
    parts.push(hash.slice(_depth*_width));
    return parts;
}

/**
 * Compute the hash of the PID
 * @param {*} pid 
 * @returns array of hash parts
 */
async function computePIDHash(pid) {
    let hash = await sha256(pid);
    return splitHash(hash);
}

async function computeSysmetaHash(pid) {
    return await sha256(`${pid}${sysmeta_formatid}`);
}

async function getSystemMetadata(pid) {
    const pid_hash = await computePIDHash(pid);
    const meta_hash = await computeSysmetaHash(pid);
    try {
        const meta_path = `${hashstore_root}/metadata/${pid_hash.join("/")}/${meta_hash}`;
        return await fs.promises.readFile(meta_path, 'utf8');
    } catch(error) {
        return null;
    }
}

async function test_sysmeta(r) {
    const pid = r.variables[1];
    const sysmeta_xml = await getSystemMetadata(pid);
    const res = []; 
    if (sysmeta_xml !== null) {
        const doc = xml.parse(sysmeta_xml);
        const ap = doc.$root.accessPolicy;
        for (const i in ap.$tags$allow) {
            const allow = ap.$tags$allow[i];
            const subject = allow.$tag$subject
            const perms = allow.$tags$permission
            for (const j in perms) {
                res.push(`${subject.$text} :: ${perms[j].$text}`);
            }
        }
    }
    const response = {
        "perms": res,
        "auth": isPublic(sysmeta_xml)
    }
    r.return(200, JSON.stringify(response, null, 2));
}

/**
 * Given system metadata XML, determine if the object is publicly readable
 * 
 * @param {*} sysmeta_xml 
 * @returns boolean
 */
function isPublic(sysmeta_xml) {
    // https://nginx.org/en/docs/njs/reference.html#xml
    if (sysmeta_xml === null) {
        // public by default
        return true;
    }
    const doc = xml.parse(sysmeta_xml);
    const policies = doc.$root.accessPolicy;
    for (const i in policies.$tags$allow) {
        const allow = policies.$tags$allow[i];
        const subject = allow.$tag$subject;
        if (subject.$text === 'public') {
            const permissions = allow.$tags$permission;
            for (const j in permissions) {
                if (permissions[j].$text === 'read') {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Check if the given token authorizes access to the PID with read permission
 * @param {*} r 
 * @param {*} token 
 * @param {*} pid 
 * @param {*} permission 
 * @returns 
 */
async function isAuthorized(r, pid) {
    const token = r.headersIn["Authorization"] || "";
    const permission = "read";
    const info = {
        "token": token,
        "permission": permission,
        "pid": pid,
        "authorized": null,
        "status": null,
        "message": null,
        "auth_url": null
    }
    const sysmeta_xml = await getSystemMetadata(pid);
    if (isPublic(sysmeta_xml)) {
        info.authorized = true;
        info.status = 200;
        info.message = "Public access";
        return info;
    }
    // Not public, check with DataONE CN
    const service_url = "https://cn.dataone.org/cn/v2/isAuthorized"
    const url = `${service_url}/${encodeURIComponent(pid)}?action=read`
    info.url = url;
    try {
        // https://nginx.org/en/docs/njs/reference.html#ngx_fetch
        const options = {
            method: 'GET',
            headers: {},
            // WARNING: Set true on a real server
            verify: false
        };
        if (token && token.length > 0) {
            options.headers["Authorization"] = token;
        }
        const response = await ngx.fetch(url, options);
        info.status = response.status;
        if (response.status === 200) {
            info.authorized = true;
            return info;
        } else {
            info.authorized = false;
            return info;
        }
    } catch (error) {
        info.authorized = false;
        info.message = error.message;
        return info;
    }
}

/**
 * Return the system metadata XML for the pid in the request variable #1
 * @param {*} r request
 */
async function getMetadata(r) {
    const pid = r.variables[1];
    console.info(`getMetadata: ${pid}`);
    const meta_data = await getSystemMetadata(pid);
    if (meta_data === null) {
        r.return(404, `System metadata not found for ${pid}`);
        return;
    }
    r.headersOut["Content-Disposition"] = `inline; filename="${pid}_meta.xml"`;
    r.headersOut["Content-Type"] = "application/xml";
    r.return(200, meta_data);
}

/**
 * Return info from the hashstore about the pid in the request variable #1
 * @param {*} r request
 */
async function getInfo(r) {
    const response = {
        "uri": r.uri,
        "pid": r.variables[1],
        "pid_path": null,
        "meta_path": null,
        "pid_data": null,
        "cid_path": null,
        "cid_data": null,
        "cid_object_path": null,
        "authorized": null,
        "message": null
    };
    console.info(`getInfo: ${response.pid}`);
    response.pid_hash = await computePIDHash(response.pid);
    response.pid_path = `${hashstore_root}/refs/pids/${response.pid_hash.join("/")}`;
    try {
        response.pid_data = await fs.promises.readFile(response.pid_path, 'utf8');
    } catch (error) {
        response.message = error.message;
        r.headersOut["Content-Disposition"] = 'inline; filename="info.json"';
        r.headersOut["Content-Type"] = "application/json";
        r.return(404, JSON.stringify(response, null, 2));
        return;
    }
    response.meta_path = `${hashstore_root}/metadata/${response.pid_hash.join("/")}/${response.pid_hash[response.pid_hash.length-1]}`;
    const cid_parts = splitHash(response.pid_data.trim());
    response.cid_path = `${hashstore_root}/refs/cids/${cid_parts.join("/")}`;
    try {
        response.cid_data = await fs.promises.readFile(response.cid_path, 'utf8');
    } catch (error) {
        response.message = error.message;
        r.headersOut["Content-Disposition"] = 'inline; filename="info.json"';
        r.headersOut["Content-Type"] = "application/json";
        r.return(404, JSON.stringify(response, null, 2));
        return;
    }
    response.cid_object_path = `/hashstore/objects/${cid_parts.join("/")}`;
    response.authorized = await isAuthorized(r, response.pid);
    r.headersOut["Content-Disposition"] = 'inline; filename="info.json"';
    r.headersOut["Content-Type"] = "application/json";
    r.return(200, JSON.stringify(response, null, 2));
}

/**
 * Return the object file path for the pid in the request variable #1
 * 
 * @param {*} r request
 * @returns 
 */
async function getObject(r) {
    const pid = r.variables[1];
    console.info(`getObject: ${pid}`);
    const pid_hash = await computePIDHash(pid);
    const pid_path = `${hashstore_root}/refs/pids/${pid_hash.join("/")}`;
    try {
        const pid_data = await fs.promises.readFile(pid_path, 'utf8');
        const cid_parts = splitHash(pid_data.trim());
        const cid_object_path = `/hashstore/objects/${cid_parts.join("/")}`;
        const authorized = await isAuthorized(r, pid);
        if (!authorized) {
            r.return(401, `Not authorized for read on ${pid}`);
        }
        r.variables.njs_object_path = cid_object_path;
        // TODO: set content-type based on file type
        r.headersOut["content-type"] = "text/csv";
        return r.internalRedirect("@serve_file");
    } catch (error) {
        r.return(404, `Not found: ${pid}`);
    }
}

export default {getInfo, getMetadata, getObject, test_sysmeta};
